// Audit counterexamples at 3d5bff7: expected failures, outside the default test glob.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { workspacePage } from '../../../../src/peer/workspace-page.js';

for (const editDuringSave of [false, true]) test(`workspace save preserves later edits: ${editDuringSave ? 'slow response' : 'normal control'}`, async () => {
  const html = workspacePage('nonce', 'csrf', '123456');
  const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1];
  const elements = new Map<string, any>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} }, value: '', textContent: '', disabled: false, replaceChildren() {} }); return elements.get(id); };
  const response = Promise.withResolvers<any>();
  let sent: any;
  const context = vm.createContext({ document: { getElementById: element }, location: { pathname: '/shared/id' },
    fetch: (_url: string, options: any) => { sent = JSON.parse(options.body); return response.promise; },
    setInterval() {}, addEventListener() {}, confirm: () => true, Date });
  vm.runInContext(source, context);
  vm.runInContext("writable=true;ready=true;selected='a.txt';version='old-hash';dirty=true", context);
  element('text').value = 'first edit';
  const saving = element('save').onclick();
  assert.equal(sent.text, 'first edit');
  if (editDuringSave) { element('text').value = 'second edit'; element('text').oninput(); }
  response.resolve({ ok: true, json: async () => ({ hash: 'hash-first-edit' }) }); await saving;
  assert.equal(vm.runInContext('dirty', context), editDuringSave, 'a write receipt only confirms the text submitted, not newer editor content');
  assert.equal(element('save').disabled, !editDuringSave);
});
