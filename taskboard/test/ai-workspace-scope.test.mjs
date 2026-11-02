import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDeviceWorkspaces, resolveAiWorkspace } from '../server/ai-chat-catalog.mjs';

test('AI writable directories contain every selected project root and no other project root', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-scope-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  for (const name of ['primary','secondary','other','fallback']) await mkdir(path.join(directory,name));
  const [primary,secondary,other,fallback] = await Promise.all(['primary','secondary','other','fallback'].map(name=>realpath(path.join(directory,name))));
  const alias=path.join(directory,'alias'); await symlink(primary,alias);
  const state=path.join(directory,'state.json');
  await writeFile(state, JSON.stringify({'local-projects':{
    selected:{rootPaths:[path.join(directory,'missing'), primary, secondary, alias]},
    unrelated:{rootPaths:[other]},
  }}));
  const projects=[{id:'selected',name:'Selected'},{id:'unrelated',name:'Other'},{id:'database',name:'Database',workspacePath:fallback}];
  const database={listProjects:async()=>projects,getProject:async id=>projects.find(p=>p.id===id)};
  const resolved=await resolveAiWorkspace('selected',state,database);
  assert.equal(resolved.workspacePath,primary);
  assert.deepEqual(resolved.addDirectories,[secondary]);
  assert.equal(resolved.addDirectories.includes(other),false);
  assert.equal(resolved.addDirectories.includes(fallback),false);
  assert.equal((await loadDeviceWorkspaces(state,database)).get('selected'),primary,'device picker retains its primary-root display contract');
  assert.deepEqual((await resolveAiWorkspace('database',state,database)).addDirectories,[]);
  await assert.rejects(resolveAiWorkspace('absent',state,database),e=>e.code==='PROJECT_NOT_FOUND');
});
