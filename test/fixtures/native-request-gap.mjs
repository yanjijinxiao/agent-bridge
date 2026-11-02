import fs from 'node:fs';
import readline from 'node:readline';
const [stateFile, trace] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let resumes = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line); if (m.id === undefined) continue;
  fs.appendFileSync(trace, JSON.stringify(m) + '\n');
  if (!m.method) continue; // Record decisions, never synthesize them.
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  let result = {};
  if (m.method === 'thread/resume') {
    resumes++;
    if (state.approval && resumes >= 2) send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread', turnId: 'turn', itemId: 'command', command: 'fixture-command', cwd: '/tmp',
      availableDecisions: ['accept', 'decline'] } });
    result = { thread: { id: 'thread' } };
  } else if (m.method === 'thread/read') result = { thread: { id: 'thread', cwd: '/tmp', projectId: null,
    status: { type: 'active', activeFlags: state.approval ? ['waitingOnApproval'] : [] } } };
  else if (m.method === 'thread/turns/list') result = m.params.itemsView === 'summary'
    ? state.invalid ? { data: [{ id: 'turn', status: 'inProgress', items: null }], nextCursor: null }
      : { data: [{ id: 'turn', status: 'inProgress', items: state.items ?? [] }], nextCursor: null }
    : { data: [{ id: 'turn', status: 'inProgress' }], nextCursor: null };
  else if (m.method === 'config/read') {
    if (state.delta) send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: {
      id: 'unrelated-item', type: 'agentMessage', questions: [], text: 'public incremental update' } } });
    result = { config: {} };
  } else if (!['initialize', 'thread/unsubscribe'].includes(m.method)) {
    send({ id: m.id, error: { code: -1, message: 'unexpected mutation' } }); continue;
  }
  send({ id: m.id, result });
}
