import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedNativeCore } from '../../../../test/fixtures/shared-native-core.mjs';
// Known failing product requirement, run explicitly with CODEX_NATIVE_QUEUE_TEST_BIN.
// This is deliberately outside test/*.test.ts and is reported as an unfixed defect.
test('queued first input must receive bridge application rules', { skip: !process.env.CODEX_NATIVE_QUEUE_TEST_BIN }, async t => {
  const core=await sharedNativeCore(t), runner=core.runner();
  const thread=await runner.createThread({cwd:core.root,projectBinding:'none',title:'Queue context gap'});
  const item=await runner.addQueuedSubmission({threadId:thread.threadId,prompt:'reply done',clientUserMessageId:'queue-context-diagnostic'});
  await runner.runQueuedSubmission({threadId:thread.threadId,cwd:core.root,queuedSubmissionId:item.id,clientUserMessageId:'queue-context-diagnostic',developerInstructions:'UNIQUE_QUEUE_CONTEXT_RULE_20261103'});
  assert.equal(core.calls.length,1);
  assert.equal(JSON.stringify(core.calls[0]).includes('UNIQUE_QUEUE_CONTEXT_RULE_20261103'),true,'queued first input must receive the same channel rules as a normal turn');
});
