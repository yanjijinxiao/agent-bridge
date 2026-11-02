import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("a knowledge MCP input pipe failure rejects its read without terminating Gateway", { skip: process.platform === "win32" }, async () => {
  const module = new URL("../src/knowledge/llm-wiki-mcp-client.ts", import.meta.url).href;
  const tool = `#!${process.execPath}
import readline from 'node:readline';
import { closeSync } from 'node:fs';
const lines=readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const m=JSON.parse(line); if(m.id===undefined)return;
  const result=m.method==='tools/list'?{tools:[{name:'search'},{name:'get_document'}]}:
    m.method==='tools/call'?{content:[{type:'text',text:'fixture evidence'}]}:{};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n',()=>{
    if(m.method!=='tools/call')return;
    lines.close();process.stdin.on('error',()=>{});process.stdin.destroy();
    try{closeSync(0);}catch{}
    setTimeout(()=>process.exit(0),1500);
  });
});
`;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
    import {LlmWikiMcpClientPool} from ${JSON.stringify(module)};
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-wiki-pipe-'));
    const bin=path.join(root,'.venv','bin');fs.mkdirSync(bin,{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),' {"type":"module"}');
    fs.writeFileSync(path.join(bin,'llm-wiki'),${JSON.stringify(tool)},{mode:0o700});
    const pool=new LlmWikiMcpClientPool();
    const kb={id:'fixture',name:'fixture wiki',rootPath:root,createdAt:'fixture',updatedAt:'fixture'};
    try{
      assert.match(await pool.call(kb,'search',{query:'first'}),/fixture evidence/);
      await new Promise(r=>setTimeout(r,100));
      await assert.rejects(pool.call(kb,'search',{query:'second'}),/EPIPE|closed|exited/i);
      process.stdout.write('RECOVERABLE_WIKI_PIPE_FAILURE');
    }finally{pool.close();fs.rmSync(root,{recursive:true,force:true});}
  `;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { timeout: 10000, maxBuffer: 10000 }).catch(error => {
      throw new Error(`Isolated knowledge MCP process failed: ${error.stderr}`, { cause: error });
    });
  assert.equal(result.stdout, "RECOVERABLE_WIKI_PIPE_FAILURE");
});
