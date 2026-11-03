import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('../src/web/knowledge-bases.js', import.meta.url), 'utf8');
function fixture(editing = false) {
  const fields = new Map<string, any>();
  const field = (id: string) => { if (!fields.has(id)) fields.set(id, { value: '', dataset: {}, hidden: false, textContent: '', focus() {} }); return fields.get(id); };
  const label = { textContent: '验证并保存' }, button = { disabled: false, querySelector: () => label };
  const dialog = { open: true, close() { this.open = false; } };
  fields.set('#knowledgeBaseDialog', dialog); fields.set('#saveKnowledgeBaseButton', button);
  const requests: any[] = [], notices: string[] = [];
  const context = vm.createContext({ state: { codexProjects: [] }, window: {},
    document: { addEventListener() {}, querySelector: field, querySelectorAll: () => [] },
    refreshData: async () => {}, toast: (text: string) => notices.push(text),
    api(url: string, options: any) { const gate = Promise.withResolvers<any>(); requests.push({ url, options, ...gate }); return gate.promise; },
  });
  vm.runInContext(source, context); context.beginKnowledgeBaseDialogSession();
  field('#editingKnowledgeBaseId').value = editing ? 'existing' : '';
  field('#editingKnowledgeBaseAccountId').value = editing ? 'one' : '';
  field('#knowledgeBaseAccountInput').value = 'one';
  field('#knowledgeBaseNameInput').value = 'submitted'; field('#knowledgeBaseRootInput').value = '/wiki';
  const save = () => context.saveKnowledgeBase({ preventDefault() {}, target: { querySelector: () => button }, submitter: null });
  const ack = (index = 0) => requests[index].resolve({ knowledgeBase: { id: editing ? 'existing' : 'created', accountId: 'one' } });
  return { context, field, dialog, button, save, ack, requests, notices };
}
for (const editing of [false, true]) test(`knowledge save retains later drafts and targets the acknowledged entity on next save (editing=${editing})`, async () => {
  const f = fixture(editing), pending = f.save();
  f.field('#knowledgeBaseNameInput').value = 'later draft'; f.ack(); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.field('#knowledgeBaseNameInput').value, 'later draft');
  assert.equal(f.field('#editingKnowledgeBaseId').value, editing ? 'existing' : 'created');
  assert.match(f.notices[0], /尚未保存/);
  const next = f.save(); assert.equal(f.requests[1].options.method, 'PATCH'); assert.equal(f.requests[1].options.body.name, 'later draft');
  f.ack(1); await next; assert.equal(f.dialog.open, false);
});
test('duplicate keyboard/programmatic submit does not send the pending knowledge mutation twice', async () => {
  const f = fixture(), a = f.save(), b = f.save();
  assert.equal(f.requests.length, 1); f.ack(); await Promise.all([a, b]);
});
test('a changed account remains a new unsaved knowledge draft after the old account is saved', async () => {
  const f = fixture(), pending = f.save(); f.field('#knowledgeBaseAccountInput').value = 'two'; f.ack(); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.field('#editingKnowledgeBaseId').value, '');
  const next = f.save(); assert.equal(f.requests[1].options.method, 'POST'); assert.equal(f.requests[1].options.body.accountId, 'two');
  f.ack(1); await next;
});
test('old dialog save cannot clear the new dialog pending guard or close its form', async () => {
  const f = fixture(), old = f.save(); f.dialog.open = false; f.context.beginKnowledgeBaseDialogSession(); f.dialog.open = true;
  const current = f.save(); f.ack(); await old; assert.equal(f.dialog.open, true); assert.equal(f.button.disabled, true);
  const duplicate = f.save(); assert.equal(f.requests.length, 2);
  f.ack(1); await Promise.all([current, duplicate]); assert.equal(f.button.disabled, false);
});
test('knowledge save failure keeps edits and permits a subsequent explicit retry', async () => {
  const f = fixture(), first = f.save(); f.field('#knowledgeBaseRootInput').value = '/later';
  f.requests[0].reject(Error('validation failed')); await first;
  assert.equal(f.dialog.open, true); assert.equal(f.field('#knowledgeBaseRootInput').value, '/later'); assert.equal(f.button.disabled, false);
  const next = f.save(); assert.equal(f.requests.length, 2); f.ack(1); await next;
});
test('unchanged knowledge draft closes on successful acknowledgement', async () => {
  const f = fixture(), pending = f.save(); f.ack(); await pending; assert.equal(f.dialog.open, false);
});
