import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { DingTalkHttpsAICardClient, DingTalkSdkAICardClient } from "../src/channels/dingtalk.js";

for (const mode of ["https", "sdk"] as const) test(`DEL-09.6: ${mode} changing progress never rewrites unchanged copy controls`, async () => {
  const writes: any[] = [], frames: any[] = [];
  const values: Record<string, string> = {};
  let reject = false, rejectStream = false;
  const state = (body: any) => {
    if (!body.cardData) return { statusCode: 200, body: { success: true, result: true } };
    writes.push(body);
    if (!reject) { const { msgContent: _unrendered, ...rendered } = body.cardData.cardParamMap; Object.assign(values, rendered); }
    return { statusCode: 200, body: { success: !reject, result: !reject } };
  };
  const stream = (body: any) => { frames.push(body); if (!rejectStream) values[body.key] = body.content; return { statusCode: 200, body: { success: !rejectStream, result: !rejectStream } }; };
  const make = () => mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const response = String(url).endsWith("/streaming") ? stream(body) : state(body);
    if (String(url).endsWith("/streaming")) return new Response(JSON.stringify(response.body));
    if (init?.method === "POST") return new Response(JSON.stringify({ success: true,
      result: String(url).endsWith("/deliver") ? [{ success: true }] : "instance" }));
    return new Response(JSON.stringify(response.body));
  }, [0], async () => {}) : new DingTalkSdkAICardClient({
    async createCardWithOptions(body) { state(body); return { statusCode: 200, body: { success: true, result: "instance" } }; },
    async deliverCardWithOptions() { return { statusCode: 200, body: { success: true, result: [{ success: true }] } }; },
    async updateCardWithOptions(body) { return state(body); },
    async streamingUpdateWithOptions(body) { return stream(body); }
  } as never, [0], async () => {});
  let transport = make();
  const input = { accessToken: "fixture", contentKey: "msgContent", outTrackId: "same-card", error: false, finalize: false,
    activity: "running" as const, text: "", progressLayout: { status: "进行中 · 16 秒", body: "进行中 · 16 秒\n\n阶段成果一",
      footer: "停止任务（发送后会中断执行）：\n\n```text\n/stop\n```\n\n复制不会发送。\n\n[打开项目 Web IDE](https://example.test/workspace/one)" } };
  const visible = () => {
    const order = JSON.parse(values.sys_full_json_obj).order as string[];
    assert.ok(order.every(key => ["msgContent", "staticMsgContent"].includes(key)), "deployed template ignores invented regions");
    return order.map(key => values[key]).join("\n\n");
  };
  const unique = () => {
    assert.equal(visible().split("/stop").length - 1, 1);
    assert.equal(visible().split("复制不会发送").length - 1, 1);
    assert.equal(visible().split("[打开项目 Web IDE]").length - 1, 1);
    assert.ok(frames.every(frame => Buffer.byteLength(frame.content) <= 1024));
    const cursorAnchor = Lexer.lex(values.msgContent).filter(token => token.type !== "space").at(-1);
    assert.equal(cursorAnchor?.type, "paragraph");
    assert.equal(cursorAnchor?.raw.trim(), "任务仍在执行", "native cursor is attached to task state, never the IDE link");
  };
  await transport.create({ ...input, cardTemplateId: "template", robotCode: "fixture", target: { type: "group", conversationId: "room" } });
  const afterCreate = writes.length;
  await transport.update(input); unique();
  assert.equal(writes.length, afterCreate, "confirmed create already installed both regions; first update must not repaint them");
  for (let i = 0; i < 20; i++) {
    input.progressLayout.body += `\n\n阶段成果${i + 2}：已核对接口`;
    const start = writes.length;
    await transport.update(input); unique();
    const changed = writes.slice(start).map(write => write.cardData.cardParamMap);
    assert.ok(changed.length, "phase outcomes must update");
    assert.ok(changed.every(map => !JSON.stringify(map).includes("/stop")), "body refresh must not rewrite a code-widget component");
    assert.ok(changed.every(map => !("sys_full_json_obj" in map)), "body refresh must not remount region ordering");
    assert.match(visible(), new RegExp(`阶段成果${i + 2}：`));
  }
  assert.equal(frames.length, 1, "only the unchanged footer is streamed once; long body updates are static");
  const beforeHeartbeat = writes.length; await transport.update(input);
  assert.equal(writes.length, beforeHeartbeat, "heartbeat changes no static fields");
  input.progressLayout.footer = input.progressLayout.footer.replace("workspace/one", "workspace/two");
  const beforeLink = writes.length; await transport.update(input); unique();
  assert.equal(writes.length, beforeLink);
  assert.equal(frames.length, 2, "only a changed footer gets a new stream frame");
  assert.match(visible(), /workspace\/two/);
  assert.doesNotMatch(visible(), /workspace\/one/);
  input.progressLayout.footer = input.progressLayout.footer.replace("workspace/two", "workspace/three");
  rejectStream = true;
  const bodyWrites = writes.length;
  await assert.rejects(transport.update(input));
  assert.match(visible(), /workspace\/two/, "failed stream does not commit the new controls");
  rejectStream = false; await transport.update(input);
  assert.match(visible(), /workspace\/three/);
  assert.equal(writes.length, bodyWrites, "retrying controls cannot repaint the phase document");
  input.progressLayout.body += "\n\n失败后重试的阶段成果"; reject = true;
  const beforeRejected = frames.length;
  await assert.rejects(transport.update(input)); assert.equal(frames.length, beforeRejected);
  reject = false; await transport.update(input); unique(); assert.match(visible(), /失败后重试的阶段成果/);
  transport = make(); await transport.update(input); unique();
  const beforeRestore = writes.length;
  input.progressLayout.body += "\n\n重连后的阶段成果"; await transport.update(input);
  assert.ok(writes.slice(beforeRestore).every(write => !JSON.stringify(write.cardData.cardParamMap).includes("/stop")));
  await transport.update({ ...input, text: "已结束", finalize: true });
  assert.doesNotMatch(visible(), /\/stop|阶段成果/);
});

for (const mode of ["https", "sdk"] as const) test(`DEL-09.7: ${mode} native cursor has its own task row for link, code and empty footers`, async () => {
  const frames: any[] = [], states: any[] = [];
  const ok = { statusCode: 200, body: { success: true, result: true } };
  const transport = mode === "https" ? new DingTalkHttpsAICardClient(async (url, init) => {
    (String(url).endsWith("/streaming") ? frames : states).push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(ok.body));
  }, [0], async () => {}) : new DingTalkSdkAICardClient({
    async updateCardWithOptions(body) { states.push(body); return ok; },
    async streamingUpdateWithOptions(body) { frames.push(body); return ok; }
  } as never, [0], async () => {});
  for (const [index, footer] of ["[打开项目 Web IDE](https://example.test/workspace/one)", "```text\n/stop\n```", ""].entries()) {
    const input = { accessToken: "fixture", contentKey: "msgContent", outTrackId: `cursor-${index}`, error: false, finalize: false,
      activity: "running" as const, text: "", progressLayout: { body: "进行中 · 已核对阶段成果", footer } };
    await transport.update(input);
    for (const activity of ["running", "recovering"] as const) {
      await transport.update({ ...input, activity });
      const tokens = Lexer.lex(frames.at(-1).content).filter(token => token.type !== "space");
      const anchor = tokens.at(-1)!;
      assert.equal(anchor.type, "paragraph");
      assert.equal(anchor.raw.trim(), activity === "recovering" ? "正在恢复原任务" : "任务仍在执行");
      assert.deepEqual(Lexer.lex(anchor.raw).flatMap(token => "tokens" in token ? token.tokens?.map(t => t.type) ?? [] : []), ["text"],
        "the native cursor's paragraph cannot contain a link, command or widget");
      assert.deepEqual(tokens.filter(token => token.type === "code").map(token => token.text), footer.includes("/stop") ? ["/stop"] : []);
      assert.ok(Buffer.byteLength(frames.at(-1).content) <= 1024);
    }
    const count = frames.length;
    await transport.update({ ...input, activity: "waiting-input", text: "等待你的回答" });
    assert.equal(frames.length, count, "waiting stops native loading without finalizing execution");
    assert.doesNotMatch(states.at(-1).cardData.cardParamMap.staticMsgContent, /任务仍在执行|正在恢复原任务/);
    await transport.update({ ...input, finalize: true, text: "已完成" });
    assert.doesNotMatch(frames.at(-1).content, /任务仍在执行|正在恢复原任务/);
    assert.doesNotMatch(states.at(-1).cardData.cardParamMap.staticMsgContent, /任务仍在执行|正在恢复原任务|\/stop/);
  }
  const before = { frames: frames.length, states: states.length };
  await assert.rejects(transport.update({ accessToken: "fixture", contentKey: "msgContent", outTrackId: "budget", error: false,
    finalize: false, activity: "running", text: "", progressLayout: { body: "进行中", footer: "文".repeat(336) } }), /streaming frame budget/);
  assert.deepEqual({ frames: frames.length, states: states.length }, before, "the cursor row counts toward UTF-8 budget before any mutation");
});
