import assert from 'node:assert/strict';
import test from 'node:test';
import {AppServerCodexRunner} from '../src/codex/app-server-runner.js';

for(const existing of [false,true])for(const explicit of [false,true])test(`native settings remain inherited unless an explicit UI selection supplies them (existing=${existing}, explicit=${explicit})`,async()=>{
 const wire=new AppServerCodexRunner() as any,calls:Array<{method:string;params:any}>=[];
 wire.ensureConnected=async()=>{};wire.recyclePrivateTransportIfIdle=async()=>{};wire.unsubscribeThread=async()=>{};
 wire.inspectThread=async()=>({threadId:'thread',persistence:'active',runtimeStatus:'idle',activeFlags:[]});
 wire.request=async(method:string,params:any)=>{calls.push({method,params});return method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:'thread'}};};
 wire.waitForTurn=async()=>({threadId:'thread',turnId:'turn',text:'done',raw:''});
 const settings={sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review',runtimeWorkspaceRoots:['/selected','/selected-sibling']};
 await wire.run({cwd:'/selected',prompt:'Selected original input',...(existing?{threadId:'thread'}:{}),...(explicit?{nativeSettings:settings,imagePaths:['/tmp/selected.png']}:{})});
 const start=calls.find(c=>c.method===(existing?'thread/resume':'thread/start'))!;
 assert.ok(start);
 assert.equal(start.params.cwd,!existing||explicit?'/selected':undefined);
 for(const name of ['sandbox','approvalPolicy','approvalsReviewer','runtimeWorkspaceRoots'])assert.deepEqual(start.params[name],explicit?(settings as any)[name]:undefined);
 const turn=calls.find(c=>c.method==='turn/start')!;
 assert.deepEqual(turn.params.sandboxPolicy,explicit?{type:'workspaceWrite',writableRoots:settings.runtimeWorkspaceRoots}:undefined,'explicit settings are applied with the turn even when resume attaches a loaded owner');
 for(const name of ['approvalPolicy','approvalsReviewer','runtimeWorkspaceRoots'])assert.deepEqual(turn.params[name],explicit?(settings as any)[name]:undefined);
 assert.equal(turn.params.cwd,!existing||explicit?'/selected':undefined);
 assert.deepEqual(turn.params.input,[{type:'text',text:'Selected original input',text_elements:[]},...(explicit?[{type:'localImage',path:'/tmp/selected.png'}]:[])]);
});

test('invalid explicit permissions and relative images fail before any native write',async()=>{
 for(const input of [{nativeSettings:{sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'auto_review',runtimeWorkspaceRoots:['relative']}},{imagePaths:['relative.png']}]){
  const wire=new AppServerCodexRunner() as any;let connected=false;
  wire.ensureConnected=async()=>{connected=true;};wire.recyclePrivateTransportIfIdle=async()=>{};
  await assert.rejects(wire.run({cwd:'/selected',prompt:'input',...input}),/absolute|绝对/);
  assert.equal(connected,false);
 }
});
