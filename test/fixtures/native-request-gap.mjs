import fs from 'node:fs';
import readline from 'node:readline';
const [stateFile, trace] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let resumes = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line); if (m.id === undefined) continue;
  fs.appendFileSync(trace, JSON.stringify({ ...m, fixturePid: process.pid }) + '\n');
  if (!m.method) continue; // Record decisions, never synthesize them.
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  let result = {};
  if (m.method === 'thread/resume') {
    resumes++;
    if (state.approval && resumes >= 2) send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread', turnId: 'turn', itemId: 'command', command: 'fixture-command', cwd: '/tmp',
      availableDecisions: ['accept', 'decline'] } });
    result = { thread: { id: 'thread' } };
  } else if (m.method === 'fs/readFile' && state.stallPermissionRead) {
    continue; // A read with no response stays pending until its client is closed.
  } else if (m.method === 'fs/readFile' && state.failPermissionRead) {
    process.exit(19); // Simulate an oversized/failed bulk-read relay, never a native turn end.
  } else if (m.method === 'thread/read' && m.params.threadId === 'cold') {
    result = { thread: { id: 'cold', cwd: '/tmp', path: state.coldPath, status: { type: 'notLoaded' } } };
  } else if (m.method === 'thread/read') result = { thread: { id: 'thread', cwd: '/tmp', projectId: null,
    status: { type: 'active', activeFlags: state.approval ? ['waitingOnApproval'] : [] } } };
  else if (m.method === 'thread/turns/list') result = ['summary', 'full'].includes(m.params.itemsView)
    ? state.invalid ? { data: [{ id: 'turn', status: 'inProgress', items: null }], nextCursor: null }
      : { data: [{ id: 'turn', status: 'inProgress', itemsView: state.returnedView ?? m.params.itemsView,
        items: (m.params.itemsView === 'full' ? state.fullItems : state.summaryItems) ?? state.items ?? [] }], nextCursor: null }
    : { data: [{ id: 'turn', status: 'inProgress' }], nextCursor: null };
  else if (m.method === 'config/read') {
    if (state.delta) send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
      id: 'unrelated-item', type: 'agentMessage', questions: [], text: 'public incremental update' } } });
    result = { config: {} };
  } else if (m.method === 'turn/steer' && state.allowAsyncSteer) {
    const item = { type: 'steeringUserMessage', id: 'accepted-answer', status: 'accepted', input: m.params.input };
    const items = [...(state.fullItems ?? state.items ?? []), item];
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, items, fullItems: items }));
    send({ id: m.id, result: { turnId: 'turn' } });
    send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item } });
    continue;
  } else if (!['initialize', 'thread/unsubscribe'].includes(m.method)) {
    send({ id: m.id, error: { code: -1, message: 'unexpected mutation' } }); continue;
  }
  send({ id: m.id, result });
}
