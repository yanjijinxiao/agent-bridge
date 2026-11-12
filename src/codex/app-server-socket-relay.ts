/** JSONL stdin/stdout to the native Unix-socket WebSocket transport.
 * Shared by local daemon and SSH clients; no execution ownership or restart policy. */
export const APP_SERVER_SOCKET_RELAY = String.raw`
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const socketPath = process.argv[1] || path.join(process.env.HOME || "", ".codex", "app-server-control", "app-server-control.sock");
let socket;
// Permission records may contain up to 128 MiB before base64 encoding. Bound
// the wire envelope independently; never allocate an untrusted declared length.
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
let headerBuffer = Buffer.alloc(0);
const chunks = [];
let head = 0, offset = 0, available = 0;
let incoming;
let upgraded = false;
let fragmentOpcode = null;
let fragments = [];
let fragmentBytes = 0;
let outputBlocked = false;
let failed = false;
const queued = [];
let inputEnded = false;

function fail(error) {
  if (failed) return;
  failed = true;
  const detail = error && error.message ? error.message : String(error);
  process.stderr.write("remote Codex Desktop relay failed: " + detail + "\n");
  process.exitCode = 1;
  if (socket && !socket.destroyed) socket.destroy();
}

// Append without recopying an incomplete payload. Each byte is consumed once;
// a spanning take allocates its destination once, regardless of chunk count.
function append(chunk) { if (chunk.length) { chunks.push(chunk); available += chunk.length; } }
function take(length) {
  if (!length) return Buffer.alloc(0);
  const first = chunks[head];
  let result;
  if (first.length - offset >= length) {
    result = first.subarray(offset, offset + length);
    offset += length;
    if (offset === first.length) { chunks[head++] = undefined; offset = 0; }
  } else {
    result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = chunks[head], count = Math.min(length - written, chunk.length - offset);
      chunk.copy(result, written, offset, offset + count);
      written += count; offset += count;
      if (offset === chunk.length) { chunks[head++] = undefined; offset = 0; }
    }
  }
  available -= length;
  if (head === chunks.length) { chunks.length = 0; head = 0; }
  else if (head >= 1024 && head * 2 >= chunks.length) { chunks.splice(0, head); head = 0; }
  return result;
}
function peek(length) {
  if (chunks[head].length - offset >= length) return chunks[head].subarray(offset, offset + length);
  const result = Buffer.allocUnsafe(length);
  let written = 0, index = head, start = offset;
  while (written < length) {
    const chunk = chunks[index++], count = Math.min(length - written, chunk.length - start);
    chunk.copy(result, written, start, start + count); written += count; start = 0;
  }
  return result;
}

function frame(opcode, payload) {
  if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) throw new Error("WebSocket message is too large");
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function send(line) {
  if (failed) return;
  if (!upgraded) {
    queued.push(line);
    return;
  }
  try {
    if (!socket.write(frame(0x1, line))) {
      lines.pause(); socket.once("drain", () => { if (!failed && !inputEnded) lines.resume(); });
    }
  } catch (error) { fail(error); }
}

function handleFrame(opcode, final, payload) {
  if (opcode === 0x8) {
    socket.end(frame(0x8, Buffer.alloc(0)));
    return;
  }
  if (opcode === 0x9) {
    socket.write(frame(0xA, payload));
    return;
  }
  if (opcode === 0xA) return;
  if (opcode === 0x1 || opcode === 0x2) {
    if (fragmentOpcode !== null) return fail(new Error("Unexpected new WebSocket message fragment"));
    fragmentOpcode = opcode;
    fragments = [payload];
    fragmentBytes = payload.length;
  } else if (opcode === 0x0 && fragmentOpcode !== null) {
    fragments.push(payload);
    fragmentBytes += payload.length;
  } else {
    return fail(new Error("Unexpected WebSocket continuation"));
  }
  if (!final) return;
  const complete = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
  const completeOpcode = fragmentOpcode;
  fragmentOpcode = null;
  fragments = [];
  fragmentBytes = 0;
  if (completeOpcode === 0x1 && !process.stdout.write(complete.toString("utf8") + "\n")) {
    outputBlocked = true; socket.pause();
    process.stdout.once("drain", () => {
      outputBlocked = false;
      if (failed || socket.destroyed) return;
      parseFrames();
      if (!outputBlocked && !failed) socket.resume();
    });
  }
}

function parseFrames() {
  while (!failed && !outputBlocked) {
    if (!incoming) {
      if (available < 2) return;
      const header = peek(Math.min(available, 14));
      const first = header[0];
      const second = header[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (available < 4) return;
        length = header.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (available < 10) return;
        const largeLength = header.readBigUInt64BE(2);
        if (largeLength > BigInt(MAX_MESSAGE_BYTES)) return fail(new Error("WebSocket frame is too large"));
        length = Number(largeLength);
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskBytes = masked ? 4 : 0;
      if (available < offset + maskBytes) return;
      const opcode = first & 0x0f, final = (first & 0x80) !== 0;
      if (first & 0x70 || ![0,1,2,8,9,10].includes(opcode)
        || opcode >= 8 && (!final || length > 125)) return fail(new Error("Invalid WebSocket frame"));
      if (length > MAX_MESSAGE_BYTES || opcode < 8 && length + fragmentBytes > MAX_MESSAGE_BYTES)
        return fail(new Error("WebSocket message is too large"));
      const mask = masked ? Buffer.from(header.subarray(offset, offset + 4)) : undefined;
      take(offset + maskBytes);
      incoming = { opcode, final, length, mask };
    }
    if (available < incoming.length) return;
    const { opcode, final, length, mask } = incoming;
    incoming = undefined;
    const payload = take(length);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    handleFrame(opcode, final, payload);
  }
}

socket = net.createConnection({ path: socketPath });
socket.once("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    "GET / HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: " + key,
    "Sec-WebSocket-Version: 13",
    "",
    ""
  ].join("\r\n"));
});
socket.on("data", (chunk) => {
  if (failed) return;
  if (!upgraded) {
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    const end = headerBuffer.indexOf("\r\n\r\n");
    if (end === -1) { if (headerBuffer.length > MAX_HEADER_BYTES) fail(new Error("WebSocket upgrade headers are too large")); return; }
    if (end > MAX_HEADER_BYTES) return fail(new Error("WebSocket upgrade headers are too large"));
    const headers = headerBuffer.subarray(0, end).toString("utf8");
    append(headerBuffer.subarray(end + 4)); headerBuffer = Buffer.alloc(0);
    if (!headers.startsWith("HTTP/1.1 101")) return fail(new Error("WebSocket upgrade was rejected: " + headers.split("\r\n")[0]));
    upgraded = true;
    for (const line of queued.splice(0)) send(line);
  } else append(chunk);
  parseFrames();
});
socket.on("error", fail);
process.stdout.on("error", fail);
socket.on("close", () => {
  // A remote Desktop restart closes its control socket while Gateway still
  // holds SSH stdin open. Do not leave readline alive masquerading as a usable
  // transport; the caller must observe disconnect and open a fresh reader.
  if (!inputEnded && !process.exitCode) process.exitCode = 1;
  lines.close();
  process.stdin.destroy();
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", send);
lines.on("close", () => {
  inputEnded = true;
  if (socket && !socket.destroyed) socket.end(frame(0x8, Buffer.alloc(0)));
});
`;
