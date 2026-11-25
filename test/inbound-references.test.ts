import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";
import { decodeWeComQuote } from "../src/channels/wecom-inbound.js";
import { decodeDingTalkInbound } from "../src/channels/dingtalk-inbound.js";
import { InboundReferenceStore, referenceContext } from "../src/bridge/inbound-references.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";
import { normalizeWeixinMessage } from "../src/weixin/messages.js";
import { responseBytes } from "../src/channels/inbound-bytes.js";
import type { ChannelMessage } from "../src/channels/message.js";
import { APP_SERVER_BACKEND_CAPABILITIES, type CodexSteerInput } from "../src/codex/backend.js";
import { BridgeService } from "../src/bridge/service.js";

for(const raw of ["{invalid", "{}", '[{"conversationId":"chat","messageId":"original","text":"unsafe","at":1,"attachments":{}}]'])
test("corrupt optional reference caches preserve evidence without blocking an account",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"reference-corruption-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,"cache.json");fs.writeFileSync(file,raw);
 const cache=new InboundReferenceStore(file),preserved=fs.readdirSync(dir).find(name=>name.endsWith(".corrupt"));
 assert.ok(preserved);assert.equal(fs.readFileSync(path.join(dir,preserved),"utf8"),raw);
 const message:ChannelMessage={id:"reply",senderId:"actor",replyTargetId:"chat",text:"read quote",raw:{},references:[{messageId:"original",type:"text",attachments:[],availability:"metadata-only"}]};
 assert.equal(cache.resolve(message).references![0].availability,"metadata-only");
 cache.remember({...message,id:"new",text:"new reference"},[]);
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8"))[0].messageId,"new");
});
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";

test("DingTalk separates current command from a quoted file and keeps credentials opaque", () => {
  const decoded = decodeDingTalkInbound({ msgtype: "text", text: { content: "你能看吗？", repliedMsg: {
    msgType: "file", msgId: "original", content: JSON.stringify({ fileName: "MCT.md", downloadCode: "private-download-code" })
  } } });
  assert.equal(decoded.text, "你能看吗？");
  assert.equal(decoded.references[0].attachments[0].kind, "file");
  assert.equal(decoded.references[0].attachments[0].sourceMessageId, "original");
  assert.doesNotMatch(referenceContext({ ...decoded, id: "reply", senderId: "actor", raw: {} }), /private-download-code/);
  const quoted = decodeDingTalkInbound({ msgtype: "text", text: { content: "解释", repliedMsg: {
    msgType: "text", content: { text: "/stop" }
  } } });
  assert.equal(quoted.text, "解释");
  assert.equal(quoted.references[0].text, "/stop");
});

test("DingTalk reports unavailable quoted files honestly and decodes direct files/links", () => {
  const file = decodeDingTalkInbound({ msgtype: "file", content: { fileName: "MCT.md", downloadCode: "secret" } });
  assert.equal(file.attachments[0].label, "MCT.md");
  const missing = decodeDingTalkInbound({ msgtype: "text", text: { content: "阅读", repliedMsg: {
    msgType: "file", msgId: "missing", content: { fileName: "MCT.md", fileId: "not-downloadable" }
  } } });
  assert.equal(missing.references[0].availability, "metadata-only");
  assert.match(missing.references[0].reason!, /下载凭据/);
  const card = decodeDingTalkInbound({ msgtype: "interactiveCard", content: { title: "文档", biz_custom_action_url: "https://example.com/doc" } });
  assert.match(card.text, /https:\/\/example.com\/doc/);
});

test("account reference cache survives reload and never leaks across conversations or stores tokens", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reference-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "cache.json");
  const message: ChannelMessage = { id: "original", senderId: "actor", replyTargetId: "chat", text: "说明", attachments: [], raw: {} };
  new InboundReferenceStore(filePath).remember(message, [{ kind: "file", label: "MCT.md", path: path.join(dir, "MCT.md"), item: { downloadCode: "TOKEN" } }]);
  const cache = new InboundReferenceStore(filePath);
  const reply = { ...message, id: "reply", references: [{ messageId: "original", type: "file", attachments: [], availability: "metadata-only" as const }] };
  assert.equal(cache.resolve(reply).references![0].attachments[0].sourceMessageId, "original");
  assert.equal(cache.resolve({ ...reply, replyTargetId: "other-chat" }).references![0].availability, "metadata-only");
  assert.doesNotMatch(fs.readFileSync(filePath, "utf8"), /TOKEN/);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("shared client resolves both direct and quoted media once, including Weixin mixed replies", async () => {
  const image = { type: 2, image_item: { media: { encrypt_query_param: "image" } } };
  const message = normalizeWeixinMessage({ from_user_id: "actor", message_id: "new", item_list: [
    image, { type: 1, text_item: { text: "比较" }, ref_msg: { message_id: "old", message_item: image } }
  ] })!;
  let count = 0;
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, image: "available" } }, {
    async sendText() { return { messageId: "unused" }; },
    async resolveAttachments(value) { count = value.attachments.length; assert.equal(value.references?.length, 0); return value.attachments; }
  });
  await client.resolveAttachments(message);
  assert.equal(count, 2);
});

test("streaming downloads enforce the limit even without Content-Length", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }));
  await assert.rejects(responseBytes(response, 1500), /1500/);
  assert.equal(cancelled, true);
});

test("Bridge checks actor ACL before reference reads/downloads and stages quoted files for the selected remote backend", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "MCT.md");
  fs.writeFileSync(file, "Inventory 完整正文");
  const store = new RuntimeStateStore(resolveStatePaths(path.join(root, "state")));
  const project = store.createProject("remote", root, { hostId: "remote-ssh-discovered:test-host", projectKind: "remote" });
  store.createSession("chat", root, "bound", project.id);
  let referenceReads = 0, downloads = 0, stages = 0;
  const prompts: string[] = [];
  const client = createChannelClient("generic", { ...TEXT_CAPABILITIES, inbound: { ...TEXT_CAPABILITIES.inbound, file: "available" } }, {
    async sendText() { return { messageId: "reply" }; },
    async resolveReferences(message) { referenceReads++; return message; },
    async resolveAttachments(message) { downloads++; return message.attachments.map(item => ({ ...item, path: file, item: {} })); }
  });
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"] }, stateStore: store,
    channel: client, inboundDir: root, inboundReferences: new InboundReferenceStore(path.join(root, "references.json")),
    runner: {
      async stageAttachments(files, options) {
        stages++; assert.equal(options.hostId, "remote-ssh-discovered:test-host");
        assert.equal(files[0].path, fs.realpathSync(file)); return files.map(item => ({ ...item, path: "/remote/inbound/MCT.md" }));
      },
      async run(input) { prompts.push(input.prompt); return { text: "已读取", raw: "", threadId: "thread" }; },
      async stop() {},
      async getRuntimeInfo() { return {}; }
    } as never
  });
  const decoded = decodeDingTalkInbound({ msgtype: "text", text: { content: "读取这份文件", repliedMsg: {
    msgType: "file", msgId: "original", content: { fileName: "MCT.md", downloadCode: "secret" }
  } } });
  await service.handleMessage({ ...decoded, id: "blocked", senderId: "intruder", replyTargetId: "chat", raw: {} });
  assert.equal(referenceReads + downloads + stages, 0);
  await service.handleMessage({ ...decoded, id: "allowed", senderId: "actor", replyTargetId: "chat", raw: {} });
  assert.equal(downloads, 1); assert.equal(stages, 1);
  assert.match(prompts[0], /用户引用/);
  assert.match(prompts[0], /\/remote\/inbound\/MCT.md/);
  assert.doesNotMatch(prompts[0], /secret|Users\/|bridge-reference-/);
});

function activeReferenceFixture(t: test.TestContext, channel: "dingtalk" | "weixin" | "feishu" | "wecom") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-quoted-controls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const project = store.createProject("Project", root);
  const session = store.createSession("chat", root, "Original", project.id);
  store.setSessionThread(session.id, "thread");
  const file = path.join(root, "quoted-attachment");
  fs.writeFileSync(file, "fixture");
  const inputs: string[] = [];
  const replies: string[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["actor"], streamReplies: false },
    stateStore: store, inboundDir: root,
    channel: createChannelClient(channel, { ...TEXT_CAPABILITIES,
      inbound: { image: "available", file: "available", audio: "available", video: "available" } }, {
      async sendText(message) { replies.push(message.text); return { messageId: "reply" }; },
      async resolveAttachments(message) { return message.attachments.map(item => ({ ...item, path: file })); }
    }),
    runner: {
      backendInfo: () => ({ id: "app-server", capabilities: APP_SERVER_BACKEND_CAPABILITIES }),
      async inspectThread() { return { threadId: "thread", persistence: "active", runtimeStatus: "active", activeTurnId: "existing", activeFlags: [] }; },
      async steer(input: CodexSteerInput) {
        assert.equal(input.threadId, "thread"); assert.equal(input.expectedTurnId, "existing");
        inputs.push(input.prompt);
        return { status: "accepted", threadId: "thread", turnId: "existing" };
      },
      async stop() { assert.fail("quoted stop reached native control"); },
      async run() { assert.fail("quote opened another turn"); }
    } as never
  });
  return async (message: ChannelMessage, expectedReference: string, command: string) => {
    const before = inputs.length;
    await service.handleMessage(message);
    assert.equal(inputs.length, before + 1, message.id);
    const [current, reference] = inputs.at(-1)!.split("以下是用户引用的消息内容");
    assert.ok(current.includes("解读引用") && !current.includes(command), message.id);
    assert.ok(reference.includes(expectedReference), message.id);
    assert.doesNotMatch(reference, /private-media/);
    assert.match(replies.at(-1)!, /已介入/);
  };
}

test("DingTalk quoted controls in every supported message type stay in the active turn as reference data", async t => {
  const check = activeReferenceFixture(t, "dingtalk");
  for (const command of ["/stop", "/approve A1"]) {
    for (const type of ["text", "markdown", "reply", "richText", "actionCard", "interactiveCard", "file", "picture"]) {
      // Media has no command body. Encode the text as a nested original reply,
      // while exercising the real attachment resolver for this enclosing quote.
      const nested = { msgId: "nested", msgType: "text", content: { text: command } };
      const content = type === "richText" ? { richText: [{ text: command }] }
        : type === "file" || type === "picture" ? { downloadCode: "private-media", fileName: "quote.md", repliedMsg: nested }
        : { text: command };
      const message = decodeDingTalkInbound({ msgtype: "text", text: { content: "解读引用", repliedMsg: { msgId: "quoted", msgType: type, content } } });
      await check({ ...message, id: command + type, senderId: "actor", replyTargetId: "chat", raw: {} }, command, command);
    }
  }
});

function currentMessage(id: string): ChannelMessage {
  return { id, senderId: "actor", replyTargetId: "chat", text: "解读引用", attachments: [], raw: {} };
}

test("Weixin text, voice, media and unknown quotes remain data in an active turn", async t => {
  const check = activeReferenceFixture(t, "weixin");
  for (const command of ["/stop", "/approve A1"]) {
    const media = { encrypt_query_param: "private-media" };
    const variants = [
      [{ type: 1, text: command }, command],
      [{ type: 1, text_item: { text: command } }, command],
      [{ type: 3, voice_item: { text: command } }, command],
      [{ type: 2, image_item: { media } }, "[附件] image"],
      [{ type: 3, voice_item: { media } }, "[附件] voice.silk"],
      [{ type: 4, file_item: { media, file_name: command } }, "[附件] " + command],
      [{ type: 5, video_item: { media } }, "[附件] video.mp4"],
      [{ type: 999 }, "未取得原始内容"]
    ] as const;
    for (const [index, [quoted, expected]] of variants.entries()) {
      const message = normalizeWeixinMessage({ from_user_id: "actor", message_id: command + index,
        item_list: [{ type: 1, text_item: { text: "解读引用" }, ref_msg: { message_id: "original", message_item: quoted } }] })!;
      await check({ ...message, replyTargetId: "chat" }, expected, command);
    }
  }
});

test("WeCom quoted controls, mixed media, voice and unavailable originals remain data in an active turn", async t => {
  const check = activeReferenceFixture(t, "wecom");
  for (const command of ["/stop", "/approve A1"]) {
    const media = { url: "https://example.invalid/private-media" };
    const text = { msgtype: "text", text: { content: command } };
    const image = { msgtype: "image", image: media };
    const variants = [
      [text, command], [{ msgtype: "voice", voice: { content: command } }, command],
      [{ msgtype: "mixed", mixed: { msg_item: [text, image] } }, command],
      [image, "[附件] image.jpg"], [{ msgtype: "video", video: media }, "[附件] video.mp4"],
      [{ msgtype: "file", file: media }, "[附件] file"], [{ msgtype: "unknown" }, "引用缺少正文"]
    ] as const;
    for (const [index, [quoted, expected]] of variants.entries()) {
      await check({ ...currentMessage(command + index), references: decodeWeComQuote(quoted) }, expected, command);
    }
  }
});

test("Feishu parent text, media and inaccessible originals stay in the reference section of the active turn", async t => {
  const check = activeReferenceFixture(t, "feishu");
  let original = { message_id: "original", chat_id: "chat", msg_type: "text", body: { content: "" } };
  const adapter = new FeishuChannelAdapter({ channel: "feishu", accountId: "fixture", appId: "app", appSecret: "fixture", enabled: true, savedAt: "" }, {
    apiClient: { im: { v1: { message: { async get() { return { code: 0, data: { items: [original] } }; } } } } } as never,
    wsClient: { async start() {}, close() {} }
  });
  for (const command of ["/stop", "/approve A1"]) {
    const variants = [
      ["text", { text: command }, "chat", command],
      ["file", { file_key: "private-media", file_name: command }, "chat", "[附件] " + command],
      ["image", { image_key: "private-media" }, "chat", "[附件] image.png"],
      ["text", { text: command }, "other-chat", "无法取得引用原文"],
      ["unknown", { text: command }, "chat", "无法取得引用原文"]
    ] as const;
    for (const [index, [type, content, chat, expected]] of variants.entries()) {
      original = { message_id: "original", chat_id: chat, msg_type: type, body: { content: JSON.stringify(content) } };
      const message = await adapter.resolveReferences({ ...currentMessage(command + index),
        references: [{ messageId: "original", type: "unknown", attachments: [], availability: "metadata-only" }] });
      if (chat !== "chat" || type === "unknown") assert.ok(!referenceContext(message).includes(command));
      await check(message, expected, command);
    }
  }
});

test("provider quote decode distinguishes a filename or bare reference from downloadable content on all four channels",async()=>{
  const {decodeWeComContent}=await import("../src/channels/wecom-inbound.js");
  const base=(id:string)=>({id,senderId:"actor",replyTargetId:"chat",text:"inspect",attachments:[],raw:{}});
  const partial=(message:ChannelMessage)=>{
    assert.equal(message.references?.length,1);
    assert.equal(message.references[0].availability,"metadata-only");
    assert.equal(message.references[0].attachments.length,0);
    assert.match(referenceContext(message),/未取得|缺少|无法取得|未提供/);
  };
  const name="fixture.txt";
  for (const onlyName of [false,true]) {
    const dd=decodeDingTalkInbound({msgtype:"text",text:{content:"inspect",repliedMsg:{
      msgId:"original",msgType:"file",...(onlyName?{content:{fileName:name}}:{})}}});
    partial({...base("dd"),references:dd.references});
    const wx=normalizeWeixinMessage({message_id:"wx",from_user_id:"actor",item_list:[{
      type:1,text_item:{text:"inspect"},ref_msg:{message_id:"original",...(onlyName?{message_item:{type:4,file_item:{file_name:name}}}:{})}}]})!;
    partial(wx);
    assert.equal(wx.references?.[0].messageId,"original");
    partial({...base("wc"),references:decodeWeComQuote(onlyName?{msgtype:"file",file:{filename:name}}:{msgid:"original"})});
    const fsAdapter=new FeishuChannelAdapter({channel:"feishu",accountId:"f",appId:"f",appSecret:"f",enabled:true,savedAt:""},{
      apiClient:{im:{v1:{message:{async get(){return {code:0,data:{items:onlyName?[{message_id:"original",chat_id:"chat",msg_type:"file",body:{content:JSON.stringify({file_name:name})}}]:[]}};}}}}} as never, wsClient:{async start(){},close(){}}
    });
    partial(await fsAdapter.resolveReferences({...base("fs"),references:[{messageId:"original",type:"unknown",availability:"metadata-only",attachments:[]}]}));
  }
  assert.equal(decodeDingTalkInbound({msgtype:"file",content:{fileName:name,downloadCode:"fixture"}}).attachments.length,1);
  assert.equal(normalizeWeixinMessage({from_user_id:"actor",message_id:"direct",item_list:[{type:4,file_item:{file_name:name,media:{encrypt_query_param:"fixture"}}}]})!.attachments.length,1);
  assert.equal(decodeWeComContent({msgtype:"file",file:{url:"https://example.invalid/test"}}).attachments.length,1);
  const ready = Promise.withResolvers<(event: unknown) => Promise<void>>();
  const received: ChannelMessage[] = [];
  const adapter = new FeishuChannelAdapter({channel:"feishu",accountId:"f",appId:"f",appSecret:"f",enabled:true,savedAt:""},
    {apiClient:{im:{v1:{message:{}}}} as never,wsClient:{async start(input){
      ready.resolve((input.eventDispatcher as any).handles.get("im.message.receive_v1"));
    },close(){}}});
  const stop=new AbortController();
  const monitor=adapter.monitor({signal:stop.signal,async onMessage(message){received.push(message);}});
  try {
    const dispatch=await ready.promise;
    await dispatch({sender:{sender_id:{open_id:"actor"}},message:{message_id:"direct-file",chat_id:"chat",chat_type:"p2p",
      message_type:"file",content:JSON.stringify({file_key:"fixture",file_name:name})}});
    assert.equal(received[0].attachments[0].label,name);
  } finally { stop.abort(); await monitor; }
});
