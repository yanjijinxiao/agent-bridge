import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TaskboardDatabase } from '../server/database.mjs';

for (const legacyStatuses of [false, true]) {
  test(`${legacyStatuses ? 'legacy status migration' : 'current schema reopen'} preserves issue identity and related data`, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'taskboard-status-fields-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'board.sqlite');
    let db = new TaskboardDatabase(filename);
    const creator = { type: 'agent', id: 'original-creator', name: 'Original Creator', avatarUrl: 'https://example.test/creator.png' };
    const assignee = { type: 'user', id: 'original-assignee', name: 'Original Assignee', avatarUrl: 'https://example.test/assignee.png' };
    db.createProject({ id: 'audit', name: 'Audit', workspacePath: null });
    const task = db.createTask({ projectId: 'audit', title: 'Preserved issue', description: 'Body', status: 'todo',
      priority: 'high', labels: ['release'], threadId: 'native-thread', actor: creator, assignee, workflowId: 'workflow-one',
      developmentContext: { type: 'worktree', path: '/fixture/worktree', branch: 'feature/audit' },
      dueDate: '2026-11-03', recurrence: { interval: 2, unit: 'week' } });
    const comment = db.createComment(task.id, { body: 'Preserved comment', actor: creator, threadId: 'comment-thread' });
    const attachment = db.createCommentAttachment(comment.id, { id: 'attachment-one', filename: 'evidence.txt', contentType: 'text/plain', size: 4 });
    const original = db.getTask(task.id);
    db.close();
    if (legacyStatuses) {
      // A real older status constraint with later identity/assignment columns:
      // reopening must widen the status set without resetting those columns.
      const fixture = new DatabaseSync(filename);
      try {
        const schema = fixture.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tasks'").get().sql
          .replace('CREATE TABLE tasks', 'CREATE TABLE tasks_legacy')
          .replace("'in_progress', 'in_review', 'blocked', 'done', 'canceled'", "'in_progress', 'done'");
        assert.ok(!schema.includes("'in_review'"));
        fixture.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
        fixture.exec(schema);
        fixture.exec('INSERT INTO tasks_legacy SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_legacy RENAME TO tasks; COMMIT');
      } finally { fixture.close(); }
    }
    db = new TaskboardDatabase(filename);
    t.after(() => db.close());
    assert.deepEqual(db.getTask(task.id), original);
    assert.equal(db.getTask(task.identifier).id, task.id);
    assert.deepEqual(db.getComment(comment.id), { ...comment, attachments: [attachment] });
    assert.deepEqual(db.getAttachment(attachment.id), attachment);
    assert.equal(db.database.prepare('PRAGMA foreign_key_check').get(), undefined);
    const moved = db.updateTask(task.id, task.version, { status: 'in_review' }, 'new-thread');
    assert.equal(moved.status, 'in_review');
    assert.deepEqual(moved.assignee, assignee);
    assert.equal(moved.workflowId, 'workflow-one');
  });
}
