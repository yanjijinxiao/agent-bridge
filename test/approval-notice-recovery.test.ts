import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelApprovalController } from "../src/bridge/approval.js";
import { ApprovalJournal } from "../src/bridge/approval-journal.js";
import type { CodexApprovalRequest } from "../src/codex/approval.js";
import { ChannelPartialDeliveryError, ChannelProgressError } from "../src/channels/errors.js";

const request = (): CodexApprovalRequest => ({ kind: "command", hostId: "local", threadId: "thread",
  turnId: "turn", itemId: "item", nativeKey: "original-request", command: "not persisted in notice journal" });
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, "approval notice condition timed out"); await new Promise(r => setTimeout(r, 5)); }
}
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "approval-notice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "approvals.json");
}

test("INT-04.3: failed initial IM notice retains the original approval and close invents no decision", async t => {
  const file = setup(t);
  const controller = new ChannelApprovalController(async () => { throw Error("provider unavailable"); }, 60000, undefined, file);
  t.after(() => controller.close());
  let settled = false;
  const answer = controller.request("room", request()).then(value => { settled = true; return value; });
  await until(() => !controller.hasRestartBlockingWork());
  assert.equal(settled, false); assert.equal(controller.list().length, 1);
  assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "pending");
  controller.close(); assert.equal(await answer, undefined);
  assert.equal(new ApprovalJournal(file).snapshot()[0].choice, undefined);
  assert.equal(await controller.request("room", request()), undefined);
});

for (const restart of [false, true]) test(`INT-04.3: confirmed approval retries only its acknowledged card (restart=${restart})`, async t => {
  const file = setup(t), updates: string[] = [], inputs: unknown[] = [], sends: unknown[] = [];
  const original = request();
  let controller = new ChannelApprovalController(async (_to, notice) => { sends.push(notice); return { messageId: "original-card" }; },
    60000, undefined, file, { noticeRetryDelayMs: restart ? 60000 : 5,
      resolveMentions: () => [{ userId: "actor", name: "Actor" }],
      onAcceptedInput: async input => { inputs.push(input); },
      async updateCard(id, card) { updates.push(id); assert.deepEqual(card.actionGroups, []);
        if (updates.length === 1) throw Error("HTTP 503"); assert.match(card.body, /Codex 已确认/); } });
  t.after(() => controller.close());
  const decision = controller.request("room", original);
  await until(() => new ApprovalJournal(file).notice("A1")?.messageId === "original-card");
  controller.decide("room", "A1", "accept"); assert.equal(await decision, "accept");
  await controller.reportResult("room", original, "confirmed");
  assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "confirmed");
  assert.equal(new ApprovalJournal(file).notice("A1")?.delivery, "unconfirmed");
  assert.equal(controller.hasRestartBlockingWork(), false, "backoff is not an active transfer or restart gate");
  if (restart) {
    controller.close();
    // Simulate death after a card update was sent but before its ACK commit.
    const journal = new ApprovalJournal(file), record = journal.notice("A1")!;
    journal.updateNotice("A1", { ...record, delivery: "pending", retryAt: undefined });
    controller = new ChannelApprovalController(async () => { throw Error("must not create another notice"); }, 60000, undefined, file, {
      noticeRetryDelayMs: 5, updateCard: async id => { updates.push(id); },
    });
  }
  await until(() => new ApprovalJournal(file).notice("A1")?.delivery === "delivered");
  await controller.reportResult("room", original, "confirmed");
  assert.deepEqual(updates, ["original-card", "original-card"]);
  assert.equal(sends.length, 1); assert.equal(inputs.length, 1);
  assert.equal(controller.acceptedPresentationInputs().length, 1);
  assert.match(controller.decide("room", "A1", "accept"), /没有待审批/);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /not persisted/);
});

test("INT-04.3: a missing plain-message ACK stays unknown across duplicate callbacks and restart", async t => {
  const file = setup(t), original = request(); let sends = 0;
  const controller = new ChannelApprovalController(async () => { if (++sends > 1) throw Error("ACK lost"); }, 60000, undefined, file);
  t.after(() => controller.close());
  const decision = controller.request("room", original); controller.decide("room", "A1", "decline"); await decision;
  await controller.reportResult("room", original, "confirmed");
  await controller.reportResult("room", original, "failed");
  await controller.reportResult("room", original, "confirmed");
  controller.close();
  const next = new ChannelApprovalController(async () => { sends++; }, 60000, undefined, file);
  t.after(() => next.close()); await new Promise(r => setTimeout(r, 25));
  assert.equal(sends, 2); assert.equal(new ApprovalJournal(file).notice("A1")?.delivery, "unconfirmed");
  assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "confirmed");
});

for (const reason of ["rebound", "closed", "permanent", "budget"] as const) test(`INT-04.3: card notice retry respects ${reason}`, async t => {
  const file = setup(t); let current = true, attempts = 0;
  const controller = new ChannelApprovalController(async () => ({ messageId: "card" }), 60000, undefined, file, {
    noticeRetryDelayMs: 10, validateNotice: scope => current && scope.recipientId === "room" && scope.threadId === "thread",
    async updateCard() { attempts++; throw new ChannelProgressError(reason !== "permanent"); },
  });
  t.after(() => controller.close()); const original = request(), answer = controller.request("room", original);
  await until(() => !!new ApprovalJournal(file).notice("A1")?.messageId);
  controller.decide("room", "A1", "accept"); await answer;
  await controller.reportResult("room", original, "confirmed");
  if (reason === "closed") controller.close();
  if (reason === "rebound") current = false;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(attempts, reason === "budget" ? 3 : 1);
  assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "confirmed");
  assert.equal(controller.hasRestartBlockingWork(), false);
});

test("INT-04.3: late initial card ACK and partial mention failure still close the exact old card", async t => {
  for (const partial of [false, true]) {
    const file = setup(t), ack = Promise.withResolvers<{ messageId: string }>(), updates: string[] = [];
    const controller = new ChannelApprovalController(async (_to, notice) => {
      if (!notice.card) return;
      if (partial) throw new ChannelPartialDeliveryError([{ messageId: "card", text: "approval" }], Error("mention failed"));
      return ack.promise;
    }, 60000, undefined, file, { updateCard: async id => { updates.push(id); } });
    t.after(() => controller.close());
    const original = request(), answer = controller.request("room", original);
    controller.decide("room", "A1", "decline"); await answer;
    await controller.reportResult("room", original, "confirmed"); ack.resolve({ messageId: "card" });
    await until(() => updates.length === 1);
    assert.deepEqual(updates, ["card"]); assert.equal(controller.list().length, 0);
    assert.equal(new ApprovalJournal(file).snapshot()[0].phase, "confirmed"); controller.close();
  }
});

test("INT-04.3: stopping during a card update prevents a late old-controller commit", async t => {
  const file = setup(t), update = Promise.withResolvers<void>();
  const controller = new ChannelApprovalController(async () => ({ messageId: "card" }), 60000, undefined, file, {
    updateCard: () => update.promise,
  });
  t.after(() => { update.resolve(); controller.close(); });
  const original = request(), answer = controller.request("room", original);
  await until(() => !!new ApprovalJournal(file).notice("A1")?.messageId);
  controller.decide("room", "A1", "accept"); await answer;
  const delivery = controller.reportResult("room", original, "confirmed");
  await until(() => controller.hasRestartBlockingWork());
  controller.close(); const before = fs.readFileSync(file, "utf8");
  update.resolve(); await delivery;
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("INT-04.3: an unavailable audit disk cannot spin retries or alter the confirmed native decision", async t => {
  const file = setup(t); let updates = 0;
  const controller = new ChannelApprovalController(async () => ({ messageId: "card" }), 60000, undefined, file, {
    noticeRetryDelayMs: 1, updateCard: async () => { updates++; },
    onAcceptedInput: async () => { fs.renameSync(file, file + ".saved"); fs.mkdirSync(file); },
  });
  t.after(() => controller.close());
  const original = request(), answer = controller.request("room", original);
  await until(() => !!new ApprovalJournal(file).notice("A1")?.messageId);
  controller.decide("room", "A1", "accept"); await answer;
  await assert.rejects(controller.reportResult("room", original, "confirmed"));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(updates, 0); assert.equal(controller.hasRestartBlockingWork(), false);
  assert.equal(new ApprovalJournal(file + ".saved").snapshot()[0].phase, "confirmed");
  assert.equal(controller.acceptedPresentationInputs().length, 1);
});
