import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const script = fs.readFileSync(new URL("../src/web/binding-expiry.js", import.meta.url), "utf8");
function web(overrides: { api?: (...args: any[]) => Promise<unknown> } = {}) {
  let ready: () => void = () => {};
  const elements = new Map<string, any>(), calls: any[] = [];
  for (const id of ["bindingExpiryTarget", "bindingExpiryInherit", "bindingExpiryDays", "bindingExpiryError", "bindingExpiryDialog", "bindingExpiryForm"]) {
    elements.set(`#${id}`, { value: "", checked: false, hidden: false, disabled: false, handlers: {} as Record<string, (...args: any[]) => unknown>,
      addEventListener(event: string, handler: (...args: any[]) => unknown) { this.handlers[event] = handler; },
      showModal() { this.open = true; }, close() { this.open = false; } });
  }
  elements.set('#bindingExpiryForm button[type="submit"]', { disabled: false });
  const context = vm.createContext({ document: { querySelector: (id: string) => elements.get(id),
    addEventListener(_event: string, handler: () => void) { ready = handler; } },
    escapeHtml: (s: string) => s.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    accountDisplayName: () => "DingTalk", state: { config: { bindingIdleDays: 15 } },
    api: async (url: string, options: unknown) => { calls.push({ url, options }); return overrides.api?.(url, options); }, refreshData: async () => {}, toast() {} });
  vm.runInContext(script, context); ready();
  return { context, elements, calls };
}

test("expiry UI distinguishes due-but-protected, disabled, grace and actually detached bindings", () => {
  const f = web(), render = f.context.renderBindingExpiry;
  assert.equal(render({}), "");
  for (const [status, label] of [["due", "等待安全核验"], ["disabled", "自动解绑已关闭"], ["policy-pending", "完整宽限期"], ["scheduled", "预计解绑"]]) {
    const result = render({ binding: { bound: true, expiry: { status, expiresAt: "2026-11-07T00:00:00Z" } } });
    assert.ok(result.includes(label));
  }
  assert.match(render({ binding: { bound: false, expiry: { endedReason: "idle" } } }), /session 保留/);
  assert.equal(render({ binding: { bound: false, expiry: { endedReason: "manual" } } }), "");
});

for (const rejected of [false, true]) test(`a late ${rejected ? "failed" : "successful"} expiry save cannot close or replace a newer dialog target`, async () => {
  const result = Promise.withResolvers<unknown>(), f = web({ api: () => result.promise });
  const session = (id: string) => ({ accountId: "account", id, senderId: id, threadId: id,
    binding: { bound: true, conversationId: id, hostId: "local", threadId: id,
      expiry: { generation: id, inherited: false, effectiveDays: 15 } } });
  f.context.openBindingExpiryDialog(session("first"));
  const pending = f.elements.get("#bindingExpiryForm").handlers.submit({ preventDefault() {}, submitter: { disabled: false } });
  f.elements.get("#bindingExpiryDialog").close();
  f.context.openBindingExpiryDialog(session("second"));
  if (rejected) result.reject(Error("old request failed")); else result.resolve({});
  await pending;
  assert.equal(f.elements.get("#bindingExpiryDialog").open, true);
  assert.equal(vm.runInContext("bindingExpiryTarget.sessionId", f.context), "second");
  assert.equal(f.elements.get("#bindingExpiryError").hidden, true);
});

test("expiry form submission without a submitter still saves the exact target", async () => {
  const f = web();
  f.context.openBindingExpiryDialog({ accountId: "account", id: "session", senderId: "actor", threadId: "thread",
    binding: { bound: true, conversationId: "actor", hostId: "local", threadId: "thread",
      expiry: { generation: "generation", inherited: false, effectiveDays: 15 } } });
  await f.elements.get("#bindingExpiryForm").handlers.submit({ preventDefault() {}, submitter: null });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.body.idleDays, 15);
  assert.equal(f.elements.get("#bindingExpiryDialog").open, false);
});

test("expiry dialog preserves the exact binding generation, supports 0/inherit and keeps errors visible", async () => {
  const f = web();
  const session = { accountId: "account/a", id: "managed/id", senderId: "<room>", threadId: "thread",
    binding: { bound: true, conversationId: "<room>", hostId: "remote", threadId: "thread",
      expiry: { generation: "snapshot-generation", inherited: false, effectiveDays: 15 } } };
  f.context.openBindingExpiryDialog(session);
  assert.match(f.elements.get("#bindingExpiryTarget").textContent, /<room>/, "target uses textContent, never innerHTML");
  const submit = { disabled: false }, event = { preventDefault() {}, submitter: submit };
  f.elements.get("#bindingExpiryDays").value = "0";
  await f.elements.get("#bindingExpiryForm").handlers.submit(event);
  assert.equal(f.calls[0].options.body.generation, "snapshot-generation");
  assert.equal(f.calls[0].options.body.idleDays, 0); assert.match(f.calls[0].url, /account%2Fa\/managed%2Fid\/binding-expiry/);
  f.context.openBindingExpiryDialog(session); f.elements.get("#bindingExpiryInherit").checked = true;
  await f.elements.get("#bindingExpiryForm").handlers.submit(event); assert.equal(f.calls[1].options.body.idleDays, null);
  f.context.openBindingExpiryDialog(session); f.elements.get("#bindingExpiryDays").value = "-1";
  await f.elements.get("#bindingExpiryForm").handlers.submit(event);
  assert.equal(f.calls.length, 2); assert.equal(f.elements.get("#bindingExpiryError").hidden, false); assert.equal(submit.disabled, false);
});
