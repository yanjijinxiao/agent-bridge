import assert from "node:assert/strict";
import test from "node:test";
import { FeishuCardUpdater } from "../src/channels/feishu-card-updater.js";

const card = { config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
  header: { template: "blue", title: { tag: "plain_text", content: "public question" } }, elements: [] } as const;

test("a Feishu callback may replace only its own message; a sibling card uses its exact patch target", async () => {
  const patched: string[] = [];
  const updater = new FeishuCardUpdater(async input => { patched.push(input.path.message_id); return { code: 0, data: {} }; });
  const response = await updater.respondToCallback(async () => {
    await updater.update("current", card);
    await updater.update("sibling", { ...card, header: { ...card.header, title: { tag: "plain_text", content: "sibling question" } } });
  }, "current");
  assert.equal(response?.card.data.header?.title?.content, "public question");
  assert.deepEqual(patched, ["sibling"]);
});

test("a delayed inherited callback context cannot swallow an update after the response has returned", async () => {
  const patched: string[] = [], gate = Promise.withResolvers<void>();
  const updater = new FeishuCardUpdater(async input => { patched.push(input.path.message_id); return { code: 0, data: {} }; });
  let later!: Promise<void>;
  const response = await updater.respondToCallback(async () => {
    later = gate.promise.then(() => updater.update("current", card));
  }, "current");
  assert.equal(response, undefined); gate.resolve(); await later;
  assert.deepEqual(patched, ["current"]);
});
