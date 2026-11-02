import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {BridgeService} from '../src/bridge/service.js';
import {createChannelClient,TEXT_CAPABILITIES} from '../src/channels/client.js';
import {defaultConfig} from '../src/state/config.js';
import {RuntimeStateStore} from '../src/state/runtime-state.js';
import {resolveStatePaths} from '../src/state/paths.js';

for(const setting of ['model','effort'] as const)for(const change of ['unchanged','binding','aba','role','access','stopped'])test(`restoring ${setting} inheritance retains the local write and retires stale presentation (${change})`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-default-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=new RuntimeStateStore(resolveStatePaths(root));
 const project=state.createProject('Original',root),session=state.createSession('room',root,'Original',project.id);
 state.setSessionThread(session.id,'thread-original');state.setPairedSenderIds(['actor']);state.setRole('room','actor','controller');
 state.updateSessionRuntime(session.id,{[setting]:'override'});
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let reads=0;const replies:string[]=[];
 const service=new BridgeService({stateStore:state,config:{...defaultConfig(root),streamReplies:false},
  channel:createChannelClient('generic',TEXT_CAPABILITIES,{async sendText(input){replies.push(input.text);return {messageId:'sent'};}}),
  runner:{async listModels(){return [];},async getRuntimeInfo(){reads++;if(setting==='model'||reads===2){entered.resolve();await release.promise;}return {model:'inherited',effort:'high'};}} as never});
 const pending=service.handleMessage({id:'source',senderId:'actor',replyTargetId:'room',text:`/${setting} default`,attachments:[],raw:{}});
 await entered.promise;
 assert.equal(state.getSession(session.id)?.[setting],undefined,'inheritance was already saved before the query');
 if(change==='binding'||change==='aba')state.setSessionThread(session.id,'replacement');
 if(change==='aba')state.setSessionThread(session.id,'thread-original');
 if(change==='role')state.setRole('room','actor','viewer');if(change==='access')state.setPairedSenderIds([]);
 if(change==='stopped')service.suspendUserInputs();
 release.resolve();await pending;
 assert.equal(state.getSession(session.id)?.[setting],undefined);
 if(change==='unchanged'){assert.equal(replies.length,1);assert.match(replies[0],/已恢复继承/);}else assert.deepEqual(replies,[]);
});
