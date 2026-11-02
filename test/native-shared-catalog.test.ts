import assert from 'node:assert/strict';
import test from 'node:test';
import {AppServerCodexRunner} from '../src/codex/app-server-runner.js';
import {CodexAppServerGateway} from '../src/codex/app-server-gateway.js';

test('skills discovery uses the same native connection and exact requested working directory',async()=>{
 const wire=new AppServerCodexRunner() as any,calls:unknown[]=[];
 wire.ensureConnected=async()=>{};
 wire.request=async(method:string,params:unknown)=>{calls.push([method,params]);return {data:[{cwd:'/selected',skills:[
  {name:'enabled',description:'Selected skill',path:'/selected/skill/SKILL.md',scope:'repo',enabled:true,interface:{displayName:'Selected Skill'}},
  {name:'disabled',path:'/selected/disabled/SKILL.md',enabled:false}],errors:[]}]};};
 assert.deepEqual(await wire.listSkills('/selected'),[{id:JSON.stringify(['enabled','/selected/skill/SKILL.md']),name:'enabled',label:'Selected Skill',description:'Selected skill',path:'/selected/skill/SKILL.md',scope:'repo'}]);
 assert.deepEqual(calls,[['skills/list',{cwds:['/selected'],forceReload:false}]]);
 wire.request=async()=>({data:[{cwd:'/other',skills:[],errors:[]}]});
 await assert.rejects(wire.listSkills('/selected'),/directory|目录/);
 wire.request=async()=>({data:[{cwd:'/selected',skills:[],errors:[{message:'unavailable'}]}]});
 await assert.rejects(wire.listSkills('/selected'),/catalog|目录/);
});

test('MCP discovery pages the native metadata catalog without returning authentication material',async()=>{
 const wire=new AppServerCodexRunner() as any,calls:any[]=[];
 wire.ensureConnected=async()=>{};
 wire.request=async(method:string,params:any)=>{calls.push([method,params]);return {data:[{name:params.cursor?'second':'first',authStatus:'oAuth',runtimeStatus:{state:'ready'},tools:{'tool-name':{name:'tool-name',description:'Tool description'}},resources:[],resourceTemplates:[],serverCapabilities:{secret:'PRIVATE'},toolListMeta:{token:'PRIVATE'}}],nextCursor:params.cursor?null:'page-two'};};
 const servers=await wire.listMcpServers('thread');
 assert.deepEqual(servers,[{id:'first',label:'first',authStatus:'oAuth',tools:[{name:'tool-name',description:'Tool description'}]},{id:'second',label:'second',authStatus:'oAuth',tools:[{name:'tool-name',description:'Tool description'}]}]);
 assert.deepEqual(calls,[['mcpServerStatus/list',{threadId:'thread',limit:100,detail:'full'}],['mcpServerStatus/list',{threadId:'thread',cursor:'page-two',limit:100,detail:'full'}]]);
 assert.equal(JSON.stringify(servers).includes('PRIVATE'),false);
 wire.request=async()=>({data:[],nextCursor:'repeated'});
 await assert.rejects(wire.listMcpServers(),/cursor/);
});

test('catalog operations route through the selected host adapter without another executable',async()=>{
 const calls:unknown[]=[];
 const backend={async listSkills(cwd:string){calls.push(['skills',cwd]);return [];},async listMcpServers(thread?:string){calls.push(['mcp',thread]);return [];},close(){}};
 const gateway=new CodexAppServerGateway({appServerBackend:backend as never});
 try {
  await (gateway as any).listSkills('/selected');await (gateway as any).listMcpServers('thread');
  const remote={async listSkills(cwd:string){calls.push(['remote-skills',cwd]);return [];},async listMcpServers(thread?:string){calls.push(['remote-mcp',thread]);return [];},close(){}};
  (gateway as any).remoteAppServers.set('remote',remote);
  await (gateway as any).listSkills('/remote','remote');await (gateway as any).listMcpServers('remote-thread','remote');
  assert.deepEqual(calls,[['skills','/selected'],['mcp','thread'],['remote-skills','/remote'],['remote-mcp','remote-thread']]);
 }finally{await gateway.close();}
});
