import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coldPermissionReason, ColdPermissionError } from "./cold-permission-error.js";
import { nativePermissionProjection } from "./native-permission-resume.js";

export type NativePermissionSource = (input: { file: string; threadId: string; signal: AbortSignal; timeoutMs: number }) => Promise<Record<string, unknown>>;
type ReaderCommand = (script: string, input: string) => { command: string; args: string[] };
const exec = promisify(execFile);

// Identical executable on both hosts. It reads only a native-selected rollout
// within the selected daemon's Codex home. The helper emits the verified
// thread ID, permission fields and fixed failure reasons, never raw rows.
const PERMISSION_READER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const HEADER = 128 * 1024, CHUNK = 256 * 1024, BUDGET = 128 * 1024 * 1024;
const LINE = 64 * 1024 * 1024;
const fields = ['thread_id', 'cwd', 'approval_policy', 'approvals_reviewer', 'runtime_workspace_roots',
  'active_permission_profile', 'permission_profile', 'sandbox_policy'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw { reason: 'invalid' }; };
const changed = () => { throw { reason: 'changed' }; };
const limit = () => { throw { reason: 'limit' }; };
function within(root, child) {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function read(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  if (fs.readSync(fd, buffer, 0, length, position) !== length) changed();
  return buffer;
}
function decode(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
}
function latest(fd, size, start) {
  if (size === start) return null;
  // Consume complete lines in reverse file order. Keep disjoint buffers for
  // one line so a large tool record does not cause repeated copying.
  let end = size - 1, lineSize = 0, parts = [];
  const floor = Math.max(start, end - BUDGET);
  function add(part) {
    lineSize += part.length;
    if (lineSize > LINE) limit();
    if (part.length) parts.push(part);
  }
  function finish() {
    if (lineSize === 0) invalid();
    const row = decode(parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse(), lineSize));
    parts = []; lineSize = 0;
    if (!object(row) || typeof row.type !== 'string') invalid();
    const payload = row.payload;
    if (row.type === 'event_msg' && (!object(payload) || typeof payload.type !== 'string')) invalid();
    if (row.type === 'turn_context') {
      if (!object(payload)) invalid();
      return Object.fromEntries(fields.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
    }
    if (row.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
      if (!object(payload.thread_settings) || typeof payload.thread_id !== 'string') invalid();
      const values = Object.fromEntries(fields.filter(key => Object.hasOwn(payload.thread_settings, key))
        .map(key => [key, payload.thread_settings[key]]));
      if (values.thread_id !== undefined && values.thread_id !== payload.thread_id) invalid();
      return { ...values, thread_id: payload.thread_id };
    }
  }
  while (end > floor) {
    const offset = Math.max(floor, end - CHUNK), bytes = read(fd, end - offset, offset);
    let cursor = bytes.length;
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] !== 10) continue;
      add(bytes.subarray(i + 1, cursor));
      const settings = finish();
      if (settings) return settings;
      cursor = i;
    }
    add(bytes.subarray(0, cursor));
    end = offset;
  }
  if (floor !== start) limit();
  return finish() ?? null;
}
function scan(input) {
  if (typeof input.file !== 'string' || !path.isAbsolute(input.file) || !input.file.endsWith('.jsonl')) invalid();
  const home = fs.realpathSync(input.home || path.join(require('node:os').homedir(), '.codex'));
  const resolved = fs.realpathSync(input.file);
  if (!['sessions', 'archived_sessions'].some(dir => within(path.join(home, dir), resolved))) invalid();
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd), named = fs.lstatSync(input.file);
    if (!stat.isFile() || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino || stat.size < 2) invalid();
    const header = read(fd, Math.min(stat.size, HEADER), 0), newline = header.indexOf(10);
    if (newline < 0) limit();
    const meta = decode(header.subarray(0, newline));
    if (meta?.type !== 'session_meta' || !object(meta.payload)) invalid();
    const {id, session_id, source, thread_source} = meta.payload;
    const owner = typeof id === 'string' && id.trim() ? id : session_id;
    const internal = value => typeof value === 'string' && /^(sub_?agent|guardian)/i.test(value);
    if (owner !== input.threadId || internal(source) || internal(thread_source) || object(source) && Object.keys(source).some(internal)) invalid();
    if (read(fd, 1, stat.size - 1)[0] !== 10) changed();
    const settings = latest(fd, stat.size, newline + 1);
    const after = fs.fstatSync(fd), current = fs.lstatSync(input.file);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) changed();
    return { threadId: owner, settings };
  } finally { fs.closeSync(fd); }
}
try {
  const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
  const result = JSON.stringify(scan(input));
  if (Buffer.byteLength(result) > 256 * 1024) limit();
  process.stdout.write(result);
} catch (error) {
  const reason = error.reason || (['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code) ? 'invalid' : 'unavailable');
  process.stdout.write(JSON.stringify({ error: reason }));
}
`;

export function nativePermissionSource(command: ReaderCommand, codexHome?: string): NativePermissionSource {
  return async ({ file, threadId, signal, timeoutMs }) => {
    const encoded = Buffer.from(JSON.stringify({ file, threadId, home: codexHome })).toString("base64");
    const invoke = command(PERMISSION_READER, encoded);
    let result: unknown;
    try {
      const { stdout } = await exec(invoke.command, invoke.args, { timeout: timeoutMs, signal, maxBuffer: 512 * 1024, windowsHide: true });
      result = JSON.parse(stdout);
    } catch (error) {
      const timeout = (error as { killed?: boolean })?.killed && !signal.aborted;
      throw new ColdPermissionError(timeout ? "timeout" : "unavailable", threadId);
    }
    if (!result || typeof result !== "object") throw new ColdPermissionError("invalid", threadId);
    const { threadId: owner, settings, error } = result as Record<string, unknown>;
    if (coldPermissionReason(error)) throw new ColdPermissionError(error, threadId);
    if (owner !== threadId) throw new ColdPermissionError("invalid", threadId);
    try { return settings === null ? {} : nativePermissionProjection(settings, threadId); }
    catch { throw new ColdPermissionError("invalid", threadId); }
  };
}
