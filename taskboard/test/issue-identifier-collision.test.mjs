import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskboardDatabase } from '../server/database.mjs';
import { createCloudWorkerHarness } from './helpers/cloud-worker-harness.mjs';

for (const storage of ['local', 'cloud']) {
  for (const ids of [['audit-one', 'auditone'], ['abcdefghijkl-one', 'abcdefghijkl-two']]) {
    test(`${storage} keeps identifiers unique for projects ${ids.join(' and ')}`, async t => {
      let createProject, createTask, getTask;
      if (storage === 'local') {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'taskboard-identifiers-'));
        const db = new TaskboardDatabase(path.join(directory, 'board.sqlite'));
        t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
        const actor = { type: 'user', id: 'fixture', name: 'Fixture', avatarUrl: null };
        createProject = id => db.createProject({ id, name: id, workspacePath: null });
        createTask = projectId => db.createTask({ projectId, title: projectId, description: '', status: 'backlog', priority: 'none', labels: [], actor, assignee: actor, workflowId: null, developmentContext: null, dueDate: null, recurrence: null });
        getTask = id => db.getTask(id);
      } else {
        const harness = await createCloudWorkerHarness();
        t.after(() => harness.dispose());
        const request = async (route, options) => {
          const result = await harness.request(route, { actorName: 'fixture', ...options });
          assert.ok(result.response.ok, JSON.stringify(result.body));
          return result.body;
        };
        createProject = id => request('/api/projects', { method: 'POST', json: { id, name: id } });
        createTask = async projectId => (await request('/api/tasks', { method: 'POST', json: { projectId, title: projectId } })).task;
        getTask = async id => (await request(`/api/tasks/${id}`)).task;
      }
      for (const id of ids) await createProject(id);
      const original = await createTask(ids[0]);
      const prefix = ids[0].replaceAll('-', '').toUpperCase().slice(0, 12);
      assert.equal(original.identifier, `${prefix}-1`, 'normal legacy numbering remains compatible');
      const tasks = [original, ...await Promise.all([createTask(ids[1]), createTask(ids[0]), createTask(ids[1])])];
      assert.equal(new Set(tasks.map(task => task.identifier)).size, 4);
      for (const task of tasks) {
        assert.equal((await getTask(task.identifier)).id, task.id);
        assert.equal((await getTask(task.id)).projectId, task.projectId);
      }
      const retained = await getTask(original.id);
      assert.equal(retained.identifier, original.identifier, 'existing issue identifiers never change');
      assert.equal(retained.version, original.version, 'allocation does not mutate existing issues');
    });
  }
}
