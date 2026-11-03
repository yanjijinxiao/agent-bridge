import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWeixinMessage } from '../src/weixin/messages.js';
import { monitorWeixin } from '../src/weixin/monitor.js';
import type { WeixinApiClient } from '../src/weixin/api.js';

for (const id of [undefined, '', '  ', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
  test(`inbound Weixin rejects untrustworthy event identity ${String(id)}`, () => {
    assert.throws(() => normalizeWeixinMessage({ from_user_id: 'alice', text: 'private', message_id: id as never }), /message.*id/i);
  });
}
test('native string and safe numeric IDs are preserved, senderless control records remain ignored', () => {
  for (const id of ['native-event', 0, 42]) assert.equal(normalizeWeixinMessage({ from_user_id: 'alice', message_id: id })?.id, String(id));
  assert.equal(normalizeWeixinMessage({ message_id: 'control' }), undefined);
});
for (const invalid of [{ from_user_id: 'alice', text: 'private' }, { from_user_id: 'alice', message_id: 'broken', item_list: {} }]) {
  test(`bad identity or body retains the poll cursor and still dispatches valid neighbours: ${'message_id' in invalid ? 'body' : 'id'}`, async t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
    const abort = new AbortController(), cursors: unknown[] = [], saved: string[] = [], handled: string[] = [], states: string[] = [];
    const claimed = new Set<string>();
    await monitorWeixin({ signal: abort.signal, initialSyncKey: 'old', pollIntervalMs: 0,
      client: { async getUpdates(cursor: string) {
        cursors.push(cursor);
        if (cursors.length === 1) return { get_updates_buf: 'new', msgs: [invalid, { message_id: 'good', from_user_id: 'alice', text: 'hello' }] };
        abort.abort(); return { get_updates_buf: 'new', msgs: [{ message_id: 'repaired', from_user_id: 'alice', text: 'fixed' }, { message_id: 'good', from_user_id: 'alice', text: 'hello' }] };
      } } as unknown as WeixinApiClient,
      claimMessage(message) { if (claimed.has(message.id)) return false; claimed.add(message.id); return true; },
      onStatus(status) { states.push(status.state); }, onSyncKey(key) { saved.push(key); },
      async onMessage(message) { handled.push(message.id); },
    });
    assert.deepEqual(cursors, ['old', 'old']);
    assert.deepEqual(handled, ['good', 'repaired']);
    assert.deepEqual(saved, ['new']); assert.equal(states[0], 'reconnecting'); assert.equal(states.at(-1), 'connected');
  });
}
for (const invalid of [null, 'wrong', []]) test(`non-object poll entries do not consume the source cursor: ${JSON.stringify(invalid)}`, async t => {
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const abort = new AbortController(), cursors: unknown[] = [], saved: string[] = [];
  await monitorWeixin({ signal: abort.signal, initialSyncKey: 'old', pollIntervalMs: 0,
    client: { async getUpdates(cursor: string) { cursors.push(cursor); if (cursors.length === 1) return { get_updates_buf: 'new', msgs: [invalid] }; abort.abort(); return { msgs: [] }; } } as unknown as WeixinApiClient,
    onSyncKey(key) { saved.push(key); }, async onMessage() { assert.fail('invalid entry dispatched'); } });
  assert.deepEqual(cursors, ['old', 'old']); assert.deepEqual(saved, []);
});
