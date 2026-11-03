import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { workspacePage } from '../src/peer/workspace-page.js';

function editor() {
  const source = [...workspacePage('nonce', 'csrf', '123456').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1];
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} }, value: '', textContent: '', disabled: false, replaceChildren() {} });
    return elements.get(id);
  };
  const calls: Array<{ body: any; reply: (data: any, ok?: boolean) => void }> = [];
  const context = vm.createContext({ document: { getElementById: element }, location: { pathname: '/shared/id' },
    fetch: (_url: string, options: any) => new Promise(resolve => calls.push({ body: JSON.parse(options.body),
      reply: (data, ok = true) => resolve({ ok, json: async () => data }) })),
    setInterval() {}, addEventListener() {}, confirm: () => true, Date });
  vm.runInContext(source, context);
  vm.runInContext("writable=true;ready=true;selected='a.txt';version='old-hash'", context);
  const edit = (text: string) => { element('text').value = text; element('text').oninput(); };
  edit('first edit');
  return { calls, element, edit, read: (expression: string) => vm.runInContext(expression, context), save: () => element('save').onclick() };
}

for (const laterEdit of [false, true]) test(`workspace save receipt only clears its submitted revision: ${laterEdit ? 'new edits' : 'unchanged'}`, async () => {
  const f = editor(), pending = f.save();
  assert.equal(f.calls[0].body.text, 'first edit');
  if (laterEdit) f.edit('second edit');
  assert.equal(f.element('save').disabled, true, 'serialize writes using the same hash');
  await f.save(); assert.equal(f.calls.length, 1);
  f.calls[0].reply({ hash: 'first-hash' }); await pending;
  assert.equal(f.read('dirty'), laterEdit); assert.equal(f.element('save').disabled, !laterEdit);
  if (laterEdit) {
    const next = f.save();
    assert.equal(f.calls[1].body.hash, 'first-hash'); assert.equal(f.calls[1].body.text, 'second edit');
    f.calls[1].reply({ hash: 'second-hash' }); await next; assert.equal(f.read('dirty'), false);
  }
});

for (const path of ['b.txt', 'a.txt']) test(`a delayed save cannot change a reopened file view: ${path}`, async () => {
  const f = editor(), pending = f.save();
  const opened = f.read(`openFile('${path}')`);
  f.calls[1].reply({ hash: 'reopened-hash', text: 'reopened content' }); await opened;
  f.edit('edits in the new view'); f.calls[0].reply({ hash: 'old-view-hash' }); await pending;
  assert.equal(f.read('version'), 'reopened-hash'); assert.equal(f.read('dirty'), true);
  assert.equal(f.element('text').value, 'edits in the new view');
  assert.equal(f.element('save').disabled, false);
});

test('rejected workspace save retains the draft and does not re-enable revoked access', async () => {
  const f = editor(), pending = f.save(); f.edit('unsaved draft');
  f.calls[0].reply({ error: 'file changed or permission revoked' }, false); await pending;
  assert.equal(f.read('dirty'), true); assert.equal(f.read('version'), 'old-hash');
  assert.equal(f.element('text').value, 'unsaved draft'); assert.equal(f.element('save').disabled, true);
  await f.save(); assert.equal(f.calls.length, 1);
});

test('file loading cannot discard edits made while its read was pending', async () => {
  const f = editor(), opening = f.read("openFile('b.txt')"); f.edit('newer draft');
  f.calls[0].reply({ hash: 'b-hash', text: 'b content' }); await opening;
  assert.equal(f.read('selected'), 'a.txt'); assert.equal(f.read('dirty'), true);
  assert.equal(f.element('text').value, 'newer draft');
});
