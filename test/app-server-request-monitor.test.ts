import assert from 'node:assert/strict';
import test from 'node:test';
import {AppServerRequestMonitor} from '../src/server/app-server-request-monitor.js';
const settle=async()=>{for(let n=0;n<6;n++)await new Promise<void>(r=>setImmediate(r));};

test('native subscription supervision keeps exact host/thread identity and never executes input',async t=>{
 const calls:any[]=[],live=new Set<string>();const backend={
  interactionSubscriptionReady:(thread:string,host:string)=>live.has(JSON.stringify([host,thread])),
  async observeThreadInteractions(thread:string,host:string,observer:any){calls.push(['observe',host,thread]);assert.equal(observer,on);live.add(JSON.stringify([host,thread]));},
  async unobserveThreadInteractions(thread:string,host:string){calls.push(['unobserve',host,thread]);live.delete(JSON.stringify([host,thread]));}
 };const on={onApproval:async()=>undefined};const monitor=new AppServerRequestMonitor(()=>backend as never,on);t.after(()=>monitor.stop());
 monitor.setFollowedThreads([{hostId:'local',threadId:'same'},{hostId:'remote',threadId:'same'}]);assert.equal(calls.length,0);
 monitor.start();await settle();assert.deepEqual(calls,[['observe','local','same'],['observe','remote','same']]);
 (monitor as any).tick();await settle();assert.equal(calls.length,2);assert.equal(monitor.observationHealth().connected,true);
 monitor.setFollowedThreads([{hostId:'remote',threadId:'same'}]);await settle();assert.deepEqual(calls.at(-1),['unobserve','local','same']);
 await monitor.stop();assert.deepEqual(calls.at(-1),['unobserve','remote','same']);assert.equal(monitor.observationHealth().threads.length,0);
});

test('disconnection retains only subscription intent and bounded retry, never another executor',async t=>{
 let attempts=0,available=false;const live=new Set<string>();
 const backend={interactionSubscriptionReady:(id:string)=>live.has(id),async observeThreadInteractions(id:string){attempts++;if(!available)throw Error('native endpoint down');live.add(id);},async unobserveThreadInteractions(id:string){live.delete(id);}};
 const monitor=new AppServerRequestMonitor(()=>backend as never,{onApproval:async()=>undefined},1000);t.after(()=>monitor.stop());
 monitor.setFollowedThreads(['thread']);monitor.start();await settle();assert.equal(attempts,1);
 (monitor as any).tick();await settle();assert.equal(attempts,1,'retry deadline is respected');
 available=true;for(const value of (monitor as any).targets.values())value.retryAt=0;
 (monitor as any).tick();await settle();assert.equal(attempts,2);assert.equal(monitor.observationHealth().threads[0].subscribed,true);
});

test('a late subscription after stop or target removal is withdrawn and cannot revive itself',async()=>{
 const gate=Promise.withResolvers<void>();let subscriptions=0,withdrawn=0;
 const backend={interactionSubscriptionReady:()=>false,async observeThreadInteractions(){subscriptions++;await gate.promise;},async unobserveThreadInteractions(){withdrawn++;}};
 const monitor=new AppServerRequestMonitor(()=>backend as never,{onApproval:async()=>undefined});
 monitor.setFollowedThreads(['thread']);monitor.start();await settle();await monitor.stop();gate.resolve();await settle();
 assert.equal(subscriptions,1);assert.equal(withdrawn,2);(monitor as any).tick();assert.equal(subscriptions,1);
});

test('subscription fanout is capped even when many followed native threads are unavailable',async()=>{
 const gate=Promise.withResolvers<void>();let attempts=0;
 const backend={interactionSubscriptionReady:()=>false,async observeThreadInteractions(){attempts++;await gate.promise;},async unobserveThreadInteractions(){}};
 const monitor=new AppServerRequestMonitor(()=>backend as never,{onApproval:async()=>undefined});
 monitor.setFollowedThreads(Array.from({length:20},(_,n)=>`thread-${n}`));monitor.start();await settle();assert.equal(attempts,4);
 await monitor.stop();gate.resolve();await settle();assert.equal(attempts,4);
});
