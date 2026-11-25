// The parent owns this process and its directory. Each row represents one observed channel call.
import fs from "node:fs";
import path from "node:path";
import { ThreadEventHub } from "../../src/server/thread-event-hub.ts";
import { createChannelClient, TEXT_CAPABILITIES } from "../../src/channels/client.ts";
import { TurnAudienceJournal } from "../../src/bridge/turn-audience.ts";
const [dir, phase] = process.argv.slice(2);
const events = path.join(dir, "channel.jsonl");
const audience = new TurnAudienceJournal(path.join(dir, "audience.json"));
const log = event => fs.appendFileSync(events, JSON.stringify(event) + "\n");
const subs = ["room-a", "room-b"].map(recipientId => {
  const client = createChannelClient("dingtalk", {
    ...TEXT_CAPABILITIES, progress: "available", resumableProgress: true, mentions: "available", mentionBatchSize: 50
  }, {
    async sendText() { return {messageId: "text-" + recipientId}; },
    async startTextStream(input) {
      log({op:"create", recipientId, card:input.streamId});
      if (phase === "during" && pendingSegment) process.kill(process.pid, "SIGKILL");
      return {messageId:input.streamId};
    },
    async updateTextStream() {},
    async sendMentionNotification(input) {
      log({op:"mention", recipientId:input.toUserId, actors:input.mentions.map(m => m.userId)});
      return {messageId:"mention-" + recipientId};
    }
  });
  return {key:JSON.stringify(["test-account",recipientId]), hostId:"local", threadId:"shared", recipientId, managed:false, client};
});
const receipts = path.join(dir, "accepted.jsonl");
const accepted = () => fs.existsSync(receipts) ? fs.readFileSync(receipts,"utf8").trim().split("\n").map(l=>JSON.parse(l)) : [];
const hub = new ThreadEventHub({
  filePath:path.join(dir,"follow.json"), subscriptions:()=>subs, acceptedInputs:accepted, turnAudience:audience,
  backend:()=>({async readThreadSnapshot() {
    return {state:{threadId:"shared",persistence:"active",runtimeStatus:"active",activeTurnId:"original",activeFlags:[]},
      turns:[{id:"original",status:"inProgress",messages:[]}]};
  }})
});
let pendingSegment = false;
if (phase !== "recover") {
  await hub.refresh();
  for (const [index,room,actor] of [[1,0,"alice"],[2,1,"carol"],[3,0,"alice"],[4,0,"bob"]]) {
    const sub = subs[room];
    const input = {id:"receipt-"+index, hostId:"local",threadId:"shared",turnId:"original",kind:"steer",acceptedAt:index,
      origin:{bindingKey:sub.key,conversationId:sub.recipientId,actorId:actor,mention:{userId:actor}}};
    fs.appendFileSync(receipts,JSON.stringify(input)+"\n");
    pendingSegment = index === 4;
    await hub.acceptedInput(input);
  }
  if (phase === "after") process.kill(process.pid,"SIGKILL");
  throw Error("process did not reach the requested card boundary");
}
await hub.refresh();
await hub.completion("local","shared","original","original result");
await hub.stop();
