import assert from 'node:assert/strict';
import test from 'node:test';
import {nativePublicActivity} from '../src/codex/public-item.js';
import {AppServerCodexRunner} from '../src/codex/app-server-runner.js';

for(const type of ['reasoning','autoApprovalReview','guardianReview','hookPrompt','userMessage'])test(`native public activity excludes private/internal ${type} records`,()=>{
 assert.equal(nativePublicActivity({type,id:'private',text:'PRIVATE',content:['PRIVATE'],summary:['PRIVATE'],_meta:{secret:'PRIVATE'}},true),undefined);
});
test('public tools retain item identity, bounded visible details and terminal status',()=>{
 const command=nativePublicActivity({type:'commandExecution',id:'cmd',command:'npm test',status:'completed',exitCode:0,aggregatedOutput:'ok',cwd:'/PRIVATE_HOST',_meta:{secret:'PRIVATE'}},true)!;
 assert.deepEqual(command,{type:'command_execution',role:'activity',content:'npm test',data:{itemId:'cmd',status:'completed',command:'npm test',output:'ok',exitCode:0}});
 const files=nativePublicActivity({type:'fileChange',id:'file',changes:[{path:'src/app.ts',kind:{type:'update'},diff:'PRIVATE_PATCH'}]},true)!;
 assert.deepEqual(files.data.files,['src/app.ts']);assert.equal(JSON.stringify(files).includes('PRIVATE'),false);
 const tool=nativePublicActivity({type:'mcpToolCall',id:'tool',server:'service',tool:'lookup',arguments:{query:'public',access_token:'PRIVATE',_meta:{key:'PRIVATE'}},result:{content:[{type:'text',text:'Found'}],_meta:{secret:'PRIVATE'}}},true)!;
 assert.equal(tool.type,'mcp_tool_call');assert.ok(String(tool.data.detail).includes('Found'));assert.equal(JSON.stringify(tool).includes('PRIVATE'),false);
 const large=nativePublicActivity({type:'mcpToolCall',id:'large',arguments:{rows:Array.from({length:10000},()=>({text:'x'.repeat(1000)}))}},true)!;
 assert.ok(String(large.data.detail).length<=65536);
});
test('sensitive commands do not expose their arguments or echoed output in activity details',()=>{
 const item=nativePublicActivity({type:'commandExecution',id:'cmd',command:'API_TOKEN=PRIVATE curl example.test',aggregatedOutput:'PRIVATE',status:'failed',exitCode:1},true)!;
 assert.equal(JSON.stringify(item).includes('PRIVATE'),false);assert.equal(item.data.exitCode,1);
 const long=nativePublicActivity({type:'commandExecution',id:'long',command:'x'.repeat(70000)+' API_TOKEN=PRIVATE',aggregatedOutput:'PRIVATE'},true)!;
 assert.equal(JSON.stringify(long).includes('PRIVATE'),false);
});
test('final agent text is visible while duplicate commentary uses the existing progress channel',()=>{
 assert.equal(nativePublicActivity({type:'agentMessage',id:'commentary',text:'progress',phase:'commentary'},true),undefined);
 assert.equal(nativePublicActivity({type:'agentMessage',id:'answer',text:'Final answer',phase:'final_answer'},true)?.content,'Final answer');
});
test('public items received before the start acknowledgement are delivered after accepted identity',async()=>{
 const wire=new AppServerCodexRunner() as any;const observed:string[]=[];
 wire.ensureConnected=async()=>{};wire.unsubscribeThread=async()=>{};wire.recyclePrivateTransportIfIdle=async()=>{};
 wire.request=async(method:string)=>{
  if(method==='turn/start'){
   wire.handleNotification('item/completed',{threadId:'thread',turnId:'turn',item:{type:'commandExecution',id:'cmd',command:'npm test',status:'completed',exitCode:0}},'{}');
   wire.handleNotification('item/completed',{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'answer',text:'Done',phase:'final_answer'}},'{}');
   wire.handleNotification('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}},'{}');
   return {turn:{id:'turn'}};
  }
  return {thread:{id:'thread'}};
 };
 const result=await wire.run({cwd:'/selected',prompt:'input',onTurnStarted(){observed.push('accepted');},onItem(item:any){observed.push(item.type);}});
 assert.equal(result.text,'Done');assert.deepEqual(observed,['accepted','command_execution','agent_message']);
});
