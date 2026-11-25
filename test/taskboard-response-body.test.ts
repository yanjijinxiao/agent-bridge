import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, deleteAiChatThread, listDevelopmentContexts } from "../taskboard/web/src/api.js";

test("Taskboard keeps a body cancellation distinct from a confirmed empty success and an unreadable receipt", async t => {
  const controller = new AbortController();
  const reading = Promise.withResolvers<void>();
  const abortedBody = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"contexts":'));
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
    }
  });
  const responses = [
    new Response(abortedBody), new Response("<html>interrupted response</html>"),
    new Response(null, { status: 204 }), new Response("temporarily unavailable", { status: 503 }),
    Response.json({ workspacePath: null, contexts: [] })
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    assert.ok(response);
    if (response.body === abortedBody) reading.resolve();
    return response;
  });
  const pending = listDevelopmentContexts("local", undefined, undefined, controller.signal);
  await reading.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(deleteAiChatThread("source"), (error: unknown) =>
    error instanceof ApiError && error.status === 0 && error.code === "INVALID_RESPONSE");
  await deleteAiChatThread("source");
  await assert.rejects(listDevelopmentContexts("local"), (error: unknown) => error instanceof ApiError && error.status === 503);
  assert.deepEqual(await listDevelopmentContexts("local"), { workspacePath: null, contexts: [] });
  assert.equal(responses.length, 0);
});
