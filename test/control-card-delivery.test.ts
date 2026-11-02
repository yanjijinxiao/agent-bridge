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
import {APP_SERVER_BACKEND_CAPABILITIES} from '../src/codex/backend.js';
for(const form of [false,true])for(const update of [false,true])test(`uncertain ${form?'goal form':'action'} card ${update?'update':'creation'} neither creates a replacement nor resends its body as text`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'control-card-unknown-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=new RuntimeStateStore(resolveStatePaths(root)),project=state.createProject('Project',root);
 const session=state.createSession('chat',root,'Session',project.id);state.setSessionThread(session.id,'native-thread');state.setPairedSenderIds(['chat']);
 const writes:string[]=[],unknown=()=>{throw Error('Fixture applied card then lost its acknowledgement');};
 const service=new BridgeService({stateStore:state,config:defaultConfig(root),channel:createChannelClient('generic',{
  ...TEXT_CAPABILITIES,actions:'available',tasks:'available',cardUpdates:'available'
 },{async sendText(){writes.push('text');return {messageId:'text'};},
  async sendActionCard(){writes.push('action-create');unknown();return {messageId:'created'};},
  async updateActionCard(){writes.push('action-update');unknown();},
  async sendTaskCard(){writes.push('task-create');unknown();return {messageId:'created'};},
  async updateTaskCard(){writes.push('task-update');unknown();}
 }),runner:{backendInfo(){return {id:'app-server',capabilities:APP_SERVER_BACKEND_CAPABILITIES};},
  async getGoal(){return {threadId:'native-thread',objective:'Original goal',status:'active',tokensUsed:0,timeUsedSeconds:0,createdAt:0,updatedAt:0};}
 } as never});
 await assert.rejects(service.handleMessage({id:'input',senderId:'chat',text:form?'/goal form':'/goal',raw:{},
  ...(update?{interaction:{messageId:'original-card'}}:{})}),/lost its acknowledgement/);
 assert.deepEqual(writes,[`${form?'task':'action'}-${update?'update':'create'}`]);
});
