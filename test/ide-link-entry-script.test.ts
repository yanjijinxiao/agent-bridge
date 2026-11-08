import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { IDE_LINK_ENTRY_SCRIPT } from "../src/ide/link-entry.js";

const pathname = "/workspace/0123456789abcdef0123456789abcdef";
const response = (status = 200, location = pathname) => ({ ok: status === 200, status, json: async () => ({ location }) });
function fixture(fetcher: (input: any) => Promise<any>) {
  const status = { textContent: "" }, title = { textContent: "正在打开 Web IDE" }, description = { textContent: "正在准备项目" };
  const button = { disabled: false, textContent: "重试打开" }, navigations: string[] = [], calls: any[] = [];
  let handler: (event: { preventDefault(): void }) => Promise<void>;
  let timerId = 0; const timers = new Map<number, () => void>();
  const form = { action: pathname + "?enter=link", querySelector: () => button,
    addEventListener: (_: string, callback: typeof handler) => { handler = callback; } };
  vm.runInNewContext(IDE_LINK_ENTRY_SCRIPT, {
    document: { querySelector: (selector: string) => selector.startsWith("form") ? form : selector === "h1" ? title : selector === "h1 + p" ? description : status },
    location: { pathname, replace: (value: string) => navigations.push(value) },
    AbortController, AbortSignal: {}, URLSearchParams,
    FormData: class extends Map { constructor() { super([["request", "request-proof"]]); } },
    setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 90000); timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, options: any) => { calls.push({ url, options }); return fetcher(options); }
  });
  return { status, title, description, button, navigations, calls, timers,
    click: () => handler({ preventDefault() {} }), flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test("link entry without static timeout sends one same-origin proof and clears its deadline", async () => {
  const x = fixture(async () => response()); await x.flush();
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0].options.credentials, "same-origin");
  assert.equal(x.calls[0].options.body.toString(), "request=request-proof");
  assert.equal(x.calls[0].options.signal.aborted, false); assert.deepEqual(x.navigations, [pathname]);
  assert.equal(x.timers.size, 0);
});

test("duplicate clicks do not issue concurrent proof exchanges; timeout exposes retry without navigation", async () => {
  const x = fixture(options => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Error("abort")))));
  await x.click(); assert.equal(x.calls.length, 1); assert.equal(x.button.disabled, true);
  for (const timer of x.timers.values()) timer(); await x.flush();
  assert.match(x.status.textContent, /超时/); assert.match(x.title.textContent, /尚未打开/);
  assert.equal(x.button.disabled, false); assert.equal(x.timers.size, 0); assert.equal(x.navigations.length, 0);
});

test("network failure can retry once manually and recovers the visible preparation state", async () => {
  let fail = true; const x = fixture(async () => { if (fail) throw Error("network"); return response(); }); await x.flush();
  assert.equal(x.navigations.length, 0); assert.match(x.status.textContent, /连接失败/);
  assert.equal(x.timers.size, 0); assert.equal(x.button.disabled, false);
  fail = false; await x.click();
  assert.equal(x.calls.length, 2); assert.deepEqual(x.navigations, [pathname]);
  assert.equal(x.title.textContent, "正在打开 Web IDE"); assert.match(x.description.textContent, /正在准备/);
});

for (const code of [401, 403]) test(`expired proof ${code} stays put until a user requests a fresh entry`, async () => {
  const x = fixture(async () => response(code)); await x.flush();
  assert.equal(x.navigations.length, 0); assert.match(x.status.textContent, /过期|权限/);
  assert.equal(x.button.textContent, "重新打开"); await x.click();
  assert.deepEqual(x.navigations, [pathname]); assert.equal(x.calls.length, 1);
});

test("server failures and foreign redirect results cannot navigate or expose server contents", async () => {
  const bad = fixture(async () => response(503)); await bad.flush();
  assert.match(bad.status.textContent, /HTTP 503/); assert.equal(bad.navigations.length, 0);
  for (const location of ["https://evil.test", "/workspace/another-project", pathname + "?token=secret"]) {
    const x = fixture(async () => response(200, location)); await x.flush();
    assert.match(x.status.textContent, /响应无效/); assert.equal(x.navigations.length, 0);
    assert.ok(!x.status.textContent.includes(location)); assert.equal(x.timers.size, 0);
  }
});
