import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuApiClient } from "../src/channels/feishu-sdk.js";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FeishuChannelAdapter } from "../src/channels/feishu.js";

for (const fault of ["late-resource","stalled-body","oversize","disk-full","success"] as const) {
  test(`Feishu inbound file transfer retires only its own partial files after ${fault}`,async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"feishu-budget-"));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const existing=path.join(dir,"previous-file");fs.writeFileSync(existing,"preserve");
    const delayed=Promise.withResolvers<{getReadableStream():Readable}>();
    const stalled=new Readable({read(){}});
    const client=new FeishuChannelAdapter({accountId:"account",channel:"feishu",appId:"test",appSecret:"fixture",enabled:true,savedAt:""},{
      inboundDir:dir, maxInboundBytes:8, inboundTimeoutMs:45,apiClient:{im:{v1:{message:{},messageResource:{async get(args:any){
        if(args.path.file_key==="second"){
          if(fault==="late-resource")return delayed.promise;
          if(fault==="oversize")return {getReadableStream:()=>Readable.from(["over-size-limit"])};
          if(fault==="stalled-body")return {getReadableStream:()=>stalled};
        }
        return {getReadableStream:()=>Readable.from([Buffer.from(args.path.file_key)])};
      }}}}} as never, wsClient:{async start(){},close(){}}
    });
    if(fault==="disk-full"){
      const write=fs.writeFileSync;let saved=0;
      t.mock.method(fs,"writeFileSync",function(...args:Parameters<typeof fs.writeFileSync>){
        if(++saved===2){write(args[0],"partial");throw Object.assign(Error("fixture disk full"),{code:"ENOSPC"});}
        return write(...args);
      });
    }
    const msg={id:"two-files",text:"",raw:{},senderId:"actor",attachments:["first","second"].map(key=>({
      kind:"file" as const,label:key+".txt",item:{fileKey:key,messageId:"two-files"}}))};
    const watchdog=setTimeout(()=>delayed.resolve({getReadableStream:()=>Readable.from(["arrived late"])}),450);
    // Release a stalled control on old versions, so a missing deadline fails deterministically.
    const end=setTimeout(()=>{if(!stalled.destroyed)stalled.push(null);},450);
    try {
      if(fault==="success"){
        const files=await client.resolveAttachments(msg);
        assert.deepEqual(files.map(f=>fs.readFileSync(f.path!,"utf8")),["first","second"]);
      } else {
        await assert.rejects(client.resolveAttachments(msg),err=> fault==="disk-full"
          ? (err as NodeJS.ErrnoException).code==="ENOSPC" : fault==="oversize" ? err instanceof Error && err.constructor.name==="InboundMediaTooLargeError" : (err as Error).name==="TimeoutError" || (err as Error).name==="AbortError");
        if(fault==="late-resource"){
          delayed.resolve({getReadableStream:()=>stalled});
          await new Promise(resolve=>setImmediate(resolve));
        }
        if(fault==="late-resource" || fault==="stalled-body")assert.equal(stalled.destroyed,true);
        assert.deepEqual(fs.readdirSync(dir),["previous-file"]);
      }
      assert.equal(fs.readFileSync(existing,"utf8"),"preserve");
    } finally {clearTimeout(watchdog);clearTimeout(end);stalled.destroy();}
  });
}

test("the installed Feishu SDK aborts a stalled HTTP resource without canceling its token request", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sdk-deadline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let resourceRequests = 0;
  let tokenRequests = 0;
  let resourceSignal: AbortSignal | undefined;
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (request.url?.includes("tenant_access_token")) {
      tokenRequests++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: 0, tenant_access_token: "isolated", expire: 7200 }));
    } else if (request.url?.includes("/resources/")) {
      resourceRequests++;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.from("partial"));
      response.once("close", () => closed.resolve());
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const local = (url: string) => "http://127.0.0.1:" + port + new URL(url).pathname;
  const http = {
    ...Lark.defaultHttpInstance,
    request(options: Parameters<typeof Lark.defaultHttpInstance.request>[0]) {
      if (options.url?.includes("/resources/")) resourceSignal = options.signal as AbortSignal;
      else assert.equal(options.signal, undefined);
      return Lark.defaultHttpInstance.request({ ...options, url: local(options.url!), proxy: false });
    },
    post(url: string, data?: unknown) {
      return Lark.defaultHttpInstance.post(local(url), data, { proxy: false });
    }
  };
  const account = { accountId: "test", channel: "feishu" as const, appId: path.basename(dir), appSecret: "fixture", enabled: true, savedAt: "" };
  const client = new FeishuChannelAdapter(account, {
    inboundDir: dir, inboundTimeoutMs: 1500, apiClient: createFeishuApiClient(account, http),
    wsClient: { async start() {}, close() {} }
  });
  await assert.rejects(client.resolveAttachments({
    id: "two-files", raw: {}, senderId: "actor", text: "",
    attachments: [{ kind: "file", label: "file.txt", item: { fileKey: "fixture", messageId: "message" } }]
  }));
  assert.equal(tokenRequests, 1);
  assert.equal(resourceRequests, 1);
  assert.equal(resourceSignal?.aborted, true);
  await Promise.race([closed.promise, wait(2000, undefined, { ref: false }).then(() => { throw Error("resource socket still open"); })]);
  assert.deepEqual(fs.readdirSync(dir), []);
});
