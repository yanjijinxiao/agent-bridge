import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { defaultConfig } from "../src/state/config.js";

test("history defaults to 20 public messages and more consumes the remaining snapshot without repeats", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-history-density-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStateStore(resolveStatePaths(root));
  const session = store.createSession("alice", root, "History");
  store.setSessionThread(session.id, "thread");
  const texts: string[] = [], cursors: (string | undefined)[] = [];
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["alice"] }, stateStore: store,
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } },
    runner: { async getHistoryPage(_id: string, input: { cursor?: string }) {
      cursors.push(input.cursor);
      const end = input.cursor ? Number(input.cursor) : 30, start = end - 10;
      return { messages: Array.from({ length: 10 }, (_, i) => ({ id: `h${start + i}`, role: "user", text: `history-entry-${start + i};` })),
        ...(start > 0 ? { nextCursor: String(start) } : {}) };
    } } as never });
  await service.handleMessage({ id: "h1", senderId: "alice", text: "/history", raw: {} });
  const first = texts.join("\n"); texts.length = 0;
  assert.match(first, /最近 20 条/);
  assert.deepEqual([...first.matchAll(/history-entry-(\d+);/g)].map(m => Number(m[1])), Array.from({ length: 20 }, (_, i) => i + 10));
  await service.handleMessage({ id: "h2", senderId: "alice", text: "/history more", raw: {} });
  const second = texts.join("\n");
  assert.match(second, /更早的 10 条/);
  assert.deepEqual([...second.matchAll(/history-entry-(\d+);/g)].map(m => Number(m[1])), Array.from({ length: 10 }, (_, i) => i));
  assert.deepEqual(cursors, [undefined, "20", "10"]);
});

test("queue listing shows 50 recent receipts and only cancellation choices for those visible rows", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-queue-density-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const texts: string[] = [];
  const rows = Array.from({ length: 51 }, (_, i) => ({ queuedSubmissionId: `receipt-${String(i).padStart(3, "0")}`, status: "queued", actorId: "alice", threadId: "thread" }));
  const service = new BridgeService({ config: { ...defaultConfig(root), allowedSenderIds: ["alice"] },
    accountId: "bot", stateStore: new RuntimeStateStore(resolveStatePaths(root)), runner: {} as never,
    nativeQueue: { async reconcile() {}, list(account: string, chat: string) { assert.equal(account, "bot"); assert.equal(chat, "alice"); return rows; } } as never,
    weixin: { async sendText(x) { texts.push(x.text); return { messageId: "m" }; } } });
  await service.handleMessage({ id: "q1", senderId: "alice", text: "/queue", raw: {} });
  const text = texts.join("\n");
  assert.match(text, /显示最近 50 条，共 51 条回执/);
  assert.doesNotMatch(text, /receipt-000/);
  assert.equal([...text.matchAll(/receipt-\d{3} · queued/g)].length, 50);
  assert.equal([...text.matchAll(/\/queue cancel receipt-\d{3}/g)].length, 50);
});

for (const paged of [true, false]) test(`history preserves fenced file examples and separates real attachments across both pages (paged RPC=${paged})`,async t=>{
  const {parseThreadHistory}=await import("../src/codex/app-server-runner.js");
  const {createChannelClient,TEXT_CAPABILITIES}=await import("../src/channels/client.js");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"history-receipts-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state=new RuntimeStateStore(resolveStatePaths(dir));
  const entity=state.createSession("actor",dir,"Bound history");state.setSessionThread(entity.id,"thread");
  const marker="[DingTalk file: example.txt saved to /tmp/file.txt]\nInspect the saved local attachment before answering.";
  const turns=Array.from({length:6},(_,i)=>({id:"t"+i,items:[{type:"userMessage",content:[{type:"text",
    text:`entry-${i} quoted statement\n\n\`\`\`text\n${marker}\n\`\`\`\n\n${marker}`}]},
    {type:"agentMessage",phase:"commentary",text:"hidden progress"},
    {type:"agentMessage",phase:"final_answer",text:`reply-${i}\n\n\`\`\`codex-im-gateway-actions\n{"send":[{"type":"file","path":"/tmp/not-to-send"}]}\n\`\`\``}]}));
  let bulk=0, media=0;const reads:(string|undefined)[]=[],replies:string[]=[];
  const service=new BridgeService({config:{...defaultConfig(dir),allowedSenderIds:["actor"]},stateStore:state,
    channel:createChannelClient("generic",TEXT_CAPABILITIES,{async sendText(input){replies.push(input.text);return {messageId:"ok"};},
      async sendMedia(){media++;return {messageId:"unexpected"};}}),
    runner:{async getHistoryPage(_id:string,opts:{cursor?:string}){
      reads.push(opts.cursor);if(!paged)throw Error("method not found");
      return opts.cursor ? {messages:parseThreadHistory({turns:turns.slice(0,3)})}
        : {messages:parseThreadHistory({turns:turns.slice(3)}),nextCursor:"older"};
    },async getHistory(){bulk++;return parseThreadHistory({turns});}} as never});
  for(const [i,text] of ["/history 6","/history more"].entries())await service.handleMessage({id:"h"+i,senderId:"actor",text,raw:{}});
  for(const [index,expect] of [[0,[3,4,5]],[1,[0,1,2]]] as const){
    const body=replies[index];
    assert.deepEqual([...body.matchAll(/entry-([0-9]) quoted statement/g)].map(m=>Number(m[1])),expect);
    assert.equal(body.split(marker).length-1,3);
    assert.equal(body.split("[文件：example.txt]").length-1,3);
    assert.doesNotMatch(body,/hidden progress|not-to-send/);
  }
  assert.deepEqual(reads,paged?[undefined,"older"]:[undefined]);assert.equal(bulk,paged?0:1);assert.equal(media,0);
});
