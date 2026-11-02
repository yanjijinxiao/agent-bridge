import assert from 'node:assert/strict';
import test from 'node:test';
import {RestartWork} from '../src/bridge/restart-work.js';
import {withChannelWriteLeases} from '../src/bridge/channel-write-leases.js';
import type {ChannelClient} from '../src/channels/types.js';

for(const method of ['sendText','sendMentionNotification','sendProgressText','startTextStream','resumeTextStream','updateTextStream','sendActionCard','updateActionCard','sendTaskCard','updateTaskCard','sendMedia'] as const){
 test(`channel ${method} holds only its provider write even while native execution is independent`,async()=>{
  const work=new RestartWork(),gate=Promise.withResolvers<void>();let calls=0;
  const source={value:1,async [method](){assert.equal(this.value,1);calls++;await gate.promise;return {messageId:'ack'};}};
  const client=withChannelWriteLeases(source as unknown as ChannelClient,work);
  const pending=work.run(async()=>{work.accepted({hostId:'local',threadId:'thread',turnId:'turn'});await (client[method] as Function)({});});
  assert.equal(work.hasBlockingWork(()=>true),true);assert.equal(calls,1);
  gate.resolve();await pending;assert.equal(work.hasBlockingWork(()=>true),false);
 });
}
for(const method of ['resolveReferences','resolveAttachments','sendTyping'] as const)test(`channel ${method} is not an outgoing message lease`,async()=>{
 const work=new RestartWork(),gate=Promise.withResolvers<void>();
 const client=withChannelWriteLeases({async [method](){await gate.promise;return [];}} as unknown as ChannelClient,work);
 const pending=work.run(async()=>{work.accepted({hostId:'local',threadId:'thread',turnId:'turn'});await (client[method] as Function)({});});
 assert.equal(work.hasBlockingWork(()=>true),false);gate.resolve();await pending;
});
test('channel write rejection releases its lease and remains an error',async()=>{
 const work=new RestartWork();const client=withChannelWriteLeases({sendText(){throw Error('provider rejected');}} as unknown as ChannelClient,work);
 await assert.rejects(client.sendText({toUserId:'room',text:'test'}),/provider rejected/);
 assert.equal(work.hasBlockingWork(),false);
});
