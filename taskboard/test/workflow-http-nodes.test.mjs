import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { WorkflowHttpNodes } from "../server/workflow-http-nodes.mjs";

async function fixture(t, fetch, kind = "custom-api") {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "connections.json");
  await writeFile(configPath, JSON.stringify({ version: 1, profiles: { test: {
    kinds: [kind], projectIds: ["test"], endpoint: "https://example.invalid/action", tokenEnv: "FIXTURE_ONLY_KEY",
  } } }));
  const service = new WorkflowHttpNodes({ configPath, fetch, environment: { FIXTURE_ONLY_KEY: "fixture-private-value" } });
  const step = { input: { text: 'upstream "input"' } };
  const args = { run: { projectId: "test" }, node: { data: { kind, providerProfile: "test", providerRequest: '{"message":"{{input}}"}', twitterPostContent: "test body" } },
    step, update: change => change(step), isCurrent: () => true };
  return { service, args, step };
}

test("custom API uses an authorized profile and sanitizes reflected credentials before durable output", async t => {
  let calls = 0;
  const f = await fixture(t, async (url, request) => {
    calls++; assert.equal(url, "https://example.invalid/action"); assert.equal(request.redirect, "error");
    assert.equal(request.headers.Authorization, "Bearer fixture-private-value");
    assert.deepEqual(JSON.parse(request.body), { message: 'upstream "input"' });
    return Response.json({ ok: true, nested: { token: "hide" }, reflected: "fixture-private-value" });
  });
  const output = await f.service.advance(f.args);
  assert.doesNotMatch(JSON.stringify(f.step), /fixture-private-value/);
  assert.equal(f.step.http.phase, "received"); assert.match(output.text, /已隐藏/);
  assert.deepEqual(await f.service.advance(f.args), output); assert.equal(calls, 1);
});

test("lost POST response and restored submitting marker never create a replacement request", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw Error("response lost"); });
  assert.equal(await f.service.advance(f.args), null);
  assert.equal(f.step.status, "uncertain"); assert.equal(calls, 1);
  const restored = JSON.parse(JSON.stringify(f.step)); f.args.step = restored; f.args.update = change => change(restored);
  assert.equal(await f.service.advance(f.args), null); assert.equal(calls, 1);
});

test("closing after dispatch retains an outstanding receipt", async t => {
  const release = Promise.withResolvers(); let current = true;
  const f = await fixture(t, async () => { await release.promise; return Response.json({ done: true }); });
  f.args.isCurrent = () => current;
  const work = f.service.advance(f.args);
  while (!f.step.http) await new Promise(resolve => setTimeout(resolve, 2));
  current = false; release.resolve(); await work;
  assert.equal(f.step.http.phase, "submitting");
});

test("asynchronous acceptance is not completion and an unauthorized project sends nothing", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return Response.json({ id: "job" }, { status: 202 }); });
  f.args.run.projectId = "another";
  await assert.rejects(f.service.advance(f.args), /授权/); assert.equal(calls, 0);
  f.args.run.projectId = "test"; assert.equal(await f.service.advance(f.args), null);
  assert.equal(f.step.status, "uncertain"); assert.match(f.step.error, /202/);
});

test("X uses the documented endpoint and requires its concrete post receipt", async t => {
  const f = await fixture(t, async (url, request) => {
    assert.equal(url, "https://api.x.com/2/tweets"); assert.deepEqual(JSON.parse(request.body), { text: "test body" });
    return Response.json({ data: { id: "123456", text: "test body" } }, { status: 201 });
  }, "twitter-post");
  const output = await f.service.advance(f.args); assert.equal(output.postId, "123456"); assert.equal(output.httpStatus, 201);
});
