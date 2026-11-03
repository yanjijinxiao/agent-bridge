import fs from 'node:fs';
import path from 'node:path';
import { ForwardingInbox } from '../../src/bridge/forwarding-inbox.ts';
import { InboundReceiptJournal } from '../../src/bridge/inbound-receipts.ts';

const [root, mode] = process.argv.slice(2), file = path.join(root, 'inbox.json');
let inbox, ready = false, writes = 0, failures = 0;
const journal = new InboundReceiptJournal(path.join(root, 'receipts.jsonl'), [], {
  onAccepted: receipt => inbox.accepted(receipt)
});
const target = { sessionId: 'session', threadId: 'thread', hostId: 'local', workspace: root, mode: 'session', roots: [] };
inbox = new ForwardingInbox({ filePath: file, receipts: journal, target: () => target,
  automatic: () => true, canDispatch: () => ready, notice: async () => {},
  dispatch: message => journal.handle(message, async () => { writes++; journal.accepted('thread', 'turn'); }) });
const originalRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === file && failures > 0) { failures--; throw Object.assign(Error('synthetic ENOSPC'), { code: 'ENOSPC' }); }
  return originalRename(from, to);
};
const source = { id: 'already-accepted', senderId: 'actor', replyTargetId: 'room', text: 'work', attachments: [], raw: {} };
inbox.claim(source);
inbox.start(); // A real interval is installed while dispatch is unavailable.
failures = mode === 'failure' ? 2 : 0;
await journal.handle(source, async () => { writes++; journal.accepted('thread', 'turn'); });
ready = true;
await new Promise(resolve => setTimeout(resolve, 2200));
inbox.stop();
fs.renameSync = originalRename;
console.log(JSON.stringify({ writes, rows: Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).rows).length,
  phase: new InboundReceiptJournal(path.join(root, 'receipts.jsonl')).receipt(source.id)?.phase }));
