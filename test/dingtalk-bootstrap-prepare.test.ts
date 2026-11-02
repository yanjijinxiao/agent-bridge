import assert from "node:assert/strict";
import test from "node:test";
import { DingTalkChannelAdapter } from "../src/channels/dingtalk.js";
import { DingTalkCardRouting } from "../src/channels/dingtalk-card-routing.js";
import { ChannelProgressError } from "../src/channels/errors.js";
import { canRetryUnsentCreation, type ChannelStreamBootstrap } from "../src/channels/stream-bootstrap.js";

test("token failure before card creation is known unsent and recoverable with the original logical instance", async () => {
  const routes = new DingTalkCardRouting("robot"); routes.remember("room", "2", "actor", "robot");
  let unavailable = true, creates = 0, delivers = 0, updates = 0;
  const states: ChannelStreamBootstrap[] = [];
  const adapter = new DingTalkChannelAdapter({ channel: "dingtalk", accountId: "isolated", clientId: "robot",
    clientSecret: "synthetic", cardTemplateId: "template", enabled: true, savedAt: "" }, {
    cardRouting: routes,
    streamClient: { registerCallbackListener() {}, async connect() {}, disconnect() {}, off() {}, socketCallBackResponse() {},
      async getAccessToken() { if (unavailable) throw Error("token fetch unavailable"); return "synthetic"; } },
    cardClient: { async create(input) { creates++; assert.equal(input.outTrackId, "same-instance"); },
      async deliver() { delivers++; }, async update() { updates++; } }
  });
  const input = { toUserId: "room", streamId: "same-instance", text: "public progress", onBootstrap: (state: ChannelStreamBootstrap) => states.push(state) };
  await assert.rejects(adapter.startTextStream(input), error => {
    assert.ok(error instanceof ChannelProgressError); assert.equal(error.retryable, true); return true;
  });
  assert.equal(creates, 0); assert.equal(delivers, 0); assert.equal(updates, 0);
  assert.equal(states.at(-1)?.stage, "create-rejected"); assert.equal(canRetryUnsentCreation(states.at(-1)), true);
  unavailable = false;
  assert.equal((await adapter.startTextStream(input)).messageId, "same-instance");
  assert.equal(creates, 1); assert.equal(updates, 1);
  unavailable = true;
  const previous: ChannelStreamBootstrap = { version: 1, instanceId: "same-instance", recipientId: "room", stage: "delivery-unconfirmed" };
  await assert.rejects(adapter.resumeTextStream({ ...input, bootstrap: previous, confirmUncertainDelivery: true }));
  assert.equal(states.at(-1)?.stage, "delivery-unconfirmed", "a new token failure cannot turn an earlier unknown delivery into a known rejection");
  assert.equal(creates, 1); assert.equal(delivers, 0);
  await assert.rejects(adapter.resumeTextStream({ ...input, bootstrap: states.at(-1)! }));
});
