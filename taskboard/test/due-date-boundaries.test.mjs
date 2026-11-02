import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskboardServer } from '../server/index.mjs';
import { createCloudWorkerHarness } from './helpers/cloud-worker-harness.mjs';

for (const storage of ['local', 'cloud']) {
  test(`${storage} validates calendar dates on issue create and update without mutating rejected writes`, async t => {
    let request;
    if (storage === 'cloud') {
      const harness = await createCloudWorkerHarness();
      t.after(() => harness.dispose());
      request = (route, method = 'GET', json) => harness.request(route, { actorName: 'fixture', method, json });
    } else {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'taskboard-due-date-'));
      const app = createTaskboardServer({ dataDirectory: directory });
      t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
      const address = await app.listen({ port: 0 });
      request = async (route, method = 'GET', json) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method,
          headers: { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
        return { response, body: await response.json() };
      };
    }
    assert.equal((await request('/api/projects', 'POST', { id: 'date-audit', name: 'Date Audit' })).response.status, 201);
    for (const date of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-04-31', '2026-02-29', '2026-99-99', '2026-1-02']) {
      const created = await request('/api/tasks', 'POST', { projectId: 'date-audit', title: 'Invalid date', dueDate: date });
      assert.equal(created.response.status, 400, `${date}: ${JSON.stringify(created.body)}`);
      assert.equal(created.body.error.code, 'INVALID_FIELD');
    }
    assert.deepEqual((await request('/api/tasks?projectId=date-audit')).body.tasks, []);
    const created = await request('/api/tasks', 'POST', { projectId: 'date-audit', title: 'Leap date', dueDate: '2028-02-29' });
    assert.equal(created.response.status, 201);
    const task = created.body.task;
    const failed = await request(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, dueDate: '2028-02-30' });
    assert.equal(failed.response.status, 400);
    assert.deepEqual((await request(`/api/tasks/${task.id}`)).body.task, task);
    const changed = await request(`/api/tasks/${task.id}`, 'PATCH', { version: task.version, dueDate: '2026-12-31' });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.task.dueDate, '2026-12-31');
    const cleared = await request(`/api/tasks/${task.id}`, 'PATCH', { version: changed.body.task.version, dueDate: null });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.task.dueDate, null);
  });
}
