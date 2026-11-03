import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { ApprovalJournal } from "../src/bridge/approval-journal.js";
import { sharedNativeCore, message, tool, until } from "./fixtures/shared-native-core.mjs";

for (const lostConfirmation of [false, true]) test(`INT-02.3: a real native decision is not replayed after reconnect (lostConfirmation=${lostConfirmation})`, {
  skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN, timeout: 30000
}, async t => {
  const core = await sharedNativeCore(t, (_body, n) => n === 2
    ? tool("exec_command", { cmd: "printf isolated_approval_receipt", sandbox_permissions: "require_escalated", justification: "Isolated approval receipt test" }, n)
    : message(`APPROVAL_DONE_${n}`, n));
  const owner = await core.rpc("receipt_owner");
  const { thread } = await owner.request("thread/start", { cwd: core.root, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" });
  await owner.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "initialize", text_elements: [] }] });
  await until(() => owner.events.some(e => e.method === "turn/completed"));
  const pid = (await owner.request("server/diagnostics")).process.id;
  const observer = core.runner(), file = path.join(core.root, "approval-journal.json");
  const notices: string[] = [], results: string[] = [], writes: unknown[] = [];
  const controller = new ChannelApprovalController(async (_to, notice) => { notices.push(notice.text); }, 60000, undefined, file);
  t.after(() => controller.declineAll("room"));
  const send = (observer as any).send.bind(observer);
  (observer as any).send = (value: any) => { if (!value.method) writes.push(value); return send(value); };
  if (lostConfirmation) {
    // Drop only the observer's confirmation/terminal notifications. The peer
    // independently witnesses the real native decision before this connection
    // is closed; no native responses are faked and no task is replayed.
    const handle = (observer as any).handleNotification.bind(observer);
    (observer as any).handleNotification = (method: string, ...args: unknown[]) => {
      if (!["serverRequest/resolved", "turn/completed"].includes(method)) return handle(method, ...args);
    };
  }
  await observer.observeThreadInteractions(thread.id, {
    onApproval: envelope => controller.request("room", envelope.request),
    async onResult(envelope, result) { results.push(result); await controller.reportResult("room", envelope.request, result); }
  });
  const accepted = await owner.request("turn/start", { threadId: thread.id, clientUserMessageId: "approval-once",
    input: [{ type: "text", text: "request isolated permission", text_elements: [] }] });
  await until(() => controller.list().length === 1 && owner.requests.length === 1);
  const pending = controller.list()[0];
  const denial = pending.options.find(option => option.id === "decline" || option.id === "cancel")?.id;
  assert.ok(denial, "use the denial actually offered by this native version");
  controller.decideCurrent("room", pending.id, denial, pending.version);
  await until(() => owner.events.some(e => e.method === "serverRequest/resolved" && e.params?.requestId === owner.requests[0].id));
  assert.equal(writes.length, 1); assert.deepEqual(writes[0], { id: owner.requests[0].id, result: { decision: denial } });
  if (!lostConfirmation) await until(() => results.includes("confirmed"));
  else assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "unconfirmed");
  await observer.close();
  await until(() => results.includes(lostConfirmation ? "failed" : "confirmed"));
  if (lostConfirmation) assert.ok(!results.includes("confirmed"), "missing evidence cannot become a successful decision receipt");
  const freshController = new ChannelApprovalController(async () => { throw Error("Resolved native request must not be asked again"); }, 60000, undefined, file);
  t.after(() => freshController.declineAll("room"));
  const next = core.runner(); let replayed = 0;
  await next.observeThreadInteractions(thread.id, { async onApproval() { replayed++; return undefined; } });
  await until(() => owner.events.some(e => e.method === "turn/completed" && e.params?.turn?.id === accepted.turn.id));
  await next.readThreadSnapshot(thread.id); // A native request/response barrier after reattachment.
  assert.equal(replayed, 0); assert.deepEqual(freshController.list(), []);
  assert.equal(owner.events.filter(e => e.method === "serverRequest/resolved").length, 1);
  assert.equal((await owner.request("server/diagnostics")).process.id, pid);
  assert.equal((await next.getHistory(thread.id)).filter(x => x.clientUserMessageId === "approval-once").length, 1);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /isolated_approval_receipt/);
});
