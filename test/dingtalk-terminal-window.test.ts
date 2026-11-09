import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { DingTalkChannelAdapter, DingTalkHttpsAICardClient, DingTalkSdkAICardClient } from "../src/channels/dingtalk.js";
import { ChannelTurnPresentation } from "../src/channels/turn-presentation.js";
import { createChannelClient, TEXT_CAPABILITIES } from "../src/channels/client.js";

for (const mode of ["https", "sdk"] as const)
test(`${mode} terminal fills one large card while controls stay within the small streaming field`, async t => {
 const cards=new Map<string,Record<string,string>>();let creates=0;
 const record=(kind:string,body:any)=>{
  if(kind==="create")creates++;
  const card=cards.get(body.outTrackId)??{};cards.set(body.outTrackId,card);
  if(body.cardData)Object.assign(card,body.cardData.cardParamMap);
  if(kind==="stream"){
   assert.ok(Buffer.byteLength(body.content)<=1024);assert.doesNotMatch(body.content,/LATEST|Ran terminal/);
   card[body.key]=body.content;
  }
 };
 const transport=mode==="https"?new DingTalkHttpsAICardClient(async(url,init)=>{
  const kind=String(url).endsWith("/streaming")?"stream":String(url).endsWith("/deliver")?"deliver":init?.method==="POST"?"create":"state";
  record(kind,JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({success:true,result:kind==="create"?"instance":kind==="deliver"?[{success:true}]:true}),{status:200});
 },[0],async()=>{}):new DingTalkSdkAICardClient({
  async createCardWithOptions(body){record("create",body);return{statusCode:200,body:{success:true,result:"instance"}};},
  async deliverCardWithOptions(body){record("deliver",body);return{statusCode:200,body:{success:true,result:[{success:true}]}};},
  async updateCardWithOptions(body){record("state",body);return{statusCode:200,body:{success:true,result:true}};},
  async streamingUpdateWithOptions(body){record("stream",body);return{statusCode:200,body:{success:true,result:true}};}
 } as never,[0],async()=>{});
 const base={accessToken:"fixture",contentKey:"msgContent",error:false};
 const client=createChannelClient("dingtalk",{...TEXT_CAPABILITIES,progress:"available",turnStatusHeader:"available",progressFooter:"available",resumableProgress:true,resultPageBytes:6000,terminalWindowBytes:50000},{
  measureTerminalText:DingTalkChannelAdapter.prototype.measureTerminalText,
  async sendText(){throw Error("must not create extra text messages");},
  async startTextStream(input){await transport.create({...base,...input,outTrackId:input.streamId!,cardTemplateId:"template",robotCode:"fixture",target:{type:"group",conversationId:"room"}});await transport.update({...base,...input,outTrackId:input.streamId!,finalize:false});return{messageId:input.streamId!};},
  async updateTextStream(input){await transport.update({...base,...input,outTrackId:input.messageId,finalize:input.finalize??false});}
 });
 const options={save(){},interruptControl:"request" as const,decorateProgress:(text:string)=>text+"\n\n[Web IDE](https://example.test/workspace)"};
 let stream=new ChannelTurnPresentation(client,"room",options);t.after(()=>stream.suspend());
 const visible=()=>{const card=[...cards.values()][0];return JSON.parse(card.sys_full_json_obj).order.map((key:string)=>card[key]).join("\n\n");};
 for(let i=0;i<3;i++){
  await stream.terminalScreen("OLDEST"+"终端🧪字符\n".repeat(8000)+`\n    indent\n\n• Ran terminal command\nLATEST${i}`);await stream.flush();
  const text=visible();assert.ok(Buffer.byteLength(text)>49000);assert.ok(Buffer.byteLength(text)<=50000);
  assert.match(text,new RegExp(`LATEST${i}`));assert.doesNotMatch(text,/OLDEST/);assert.match(text,/Ran terminal command/);
  assert.match(text,/Web IDE/);assert.match(text,/\u00a0{4}indent/);assert.match(text.slice(-1000),/indent {2}<br> {2}<br>/);
  assert.equal(cards.size,1);assert.equal(creates,1);assert.equal(stream.checkpoint().segments,undefined);
  assert.deepEqual(Lexer.lex([...cards.values()][0].msgContent).filter(x=>x.type==="code").map(x=>x.text),["/stop"]);
 }
 const checkpoint=stream.checkpoint();await stream.suspend();stream=new ChannelTurnPresentation(client,"room",{...options,restore:checkpoint});
 await stream.synchronize();assert.equal(cards.size,1);assert.match(visible(),/LATEST2/);
 await stream.setActivity("waiting-external");await stream.flush();assert.match(visible(),/LATEST2/);assert.doesNotMatch(visible(),/\/stop/);
 await stream.setActivity("running");await stream.flush();assert.equal(cards.size,1);assert.match(visible(),/\/stop/);
 await stream.finalize("终端当前空闲。\n\n[Web IDE](https://example.test/workspace)",false,{outcome:"terminal-idle"});
 const final=visible();assert.ok(Buffer.byteLength(final)>49000);assert.ok(Buffer.byteLength(final)<=50000);
 assert.equal(cards.size,1);assert.equal(creates,1);assert.match(final,/LATEST2/);assert.match(final,/Web IDE/);
 assert.doesNotMatch(final,/\/stop|阶段小结|完整答复/);assert.equal(stream.checkpoint().terminalPages?.length,1);
});
