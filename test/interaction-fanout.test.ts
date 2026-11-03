import assert from "node:assert/strict";
import test from "node:test";
import { NativeInteractionFanout } from "../src/codex/interaction-fanout.js";
import type { NativeApproval, NativeUserInput } from "../src/codex/interactions.js";

const approval: NativeApproval = { hostId: "local", requestId: 7, method: "item/commandExecution/requestApproval",
  request: { threadId: "thread", turnId: "turn", itemId: "item", kind: "command" } };
const input: NativeUserInput = { hostId: "local", requestId: "question", method: "item/tool/requestUserInput",
  request: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] } };

test("late native consumers observe the same pending approval and exactly one explicit answer wins", async () => {
  const fanout = new NativeInteractionFanout(), ui = Promise.withResolvers<"accept">(), im = Promise.withResolvers<"cancel">();
  const observed: unknown[] = [], confirmed: string[] = [];
  fanout.add("ui", { async onApproval(request) { observed.push(request); return ui.promise; }, onResult(_input, result) { confirmed.push(`ui:${result}`); } });
  const answer = fanout.observer.onApproval(approval);
  await Promise.resolve();
  fanout.add("im", { async onApproval(request) { observed.push(request); return im.promise; }, onResult(_input, result) { confirmed.push(`im:${result}`); } });
  im.resolve("cancel"); assert.equal(await answer, "cancel");
  ui.resolve("accept"); await fanout.observer.onResult?.(approval, "confirmed");
  assert.deepEqual(observed, [approval, approval]); assert.deepEqual(confirmed.sort(), ["im:confirmed", "ui:withdrawn"]);
  fanout.close();
});

test("retired or replaced consumers cannot answer a native request through a late promise", async () => {
  const fanout = new NativeInteractionFanout(), old = Promise.withResolvers<"accept">(), next = Promise.withResolvers<"decline">();
  fanout.add("surface", { onApproval: async () => old.promise });
  const answer = fanout.observer.onApproval(approval); await Promise.resolve();
  fanout.add("surface", { onApproval: async () => next.promise });
  old.resolve("accept"); next.resolve("decline");
  assert.equal(await answer, "decline"); fanout.close();
});

test("missing routes, consumer errors and detach leave the native request unanswered", async () => {
  for (const mode of ["empty", "error", "detach"] as const) {
    const fanout = new NativeInteractionFanout();
    if (mode !== "empty") fanout.add("surface", { async onApproval() {
      if (mode === "error") throw Error("Isolated consumer failure");
      return new Promise<"accept">(() => {});
    } });
    const answer = fanout.observer.onApproval(approval); await Promise.resolve();
    if (mode === "detach") fanout.remove("surface");
    assert.equal(await answer, undefined); fanout.close();
  }
});

test("native question fanout follows the same ownership and does not invent an answer", async () => {
  const fanout = new NativeInteractionFanout(), ui = Promise.withResolvers<any>();
  fanout.add("ui", { async onApproval() { return undefined; }, async onUserInput() { return ui.promise; } });
  const answer = fanout.observer.onUserInput!(input); await Promise.resolve();
  fanout.close(); ui.resolve({ question: { answers: ["late"] } });
  assert.equal(await answer, undefined);
});

test("an edited native question retires its old answer even when the request id is reused", async () => {
  const fanout = new NativeInteractionFanout(), old = Promise.withResolvers<any>(), edited = Promise.withResolvers<any>();
  let count = 0;
  fanout.add("ui", { async onApproval() { return undefined; }, async onUserInput() { return ++count === 1 ? old.promise : edited.promise; } });
  const first = fanout.observer.onUserInput!(input); await Promise.resolve();
  await fanout.observer.onUserInputResult?.(input, "withdrawn");
  assert.equal(await first, undefined);
  const second = fanout.observer.onUserInput!({ ...input, request: { ...input.request, questions: [{ id: "new", header: "Updated", question: "New question" }] } });
  old.resolve({ old: { answers: ["stale"] } }); edited.resolve({ new: { answers: ["current"] } });
  assert.deepEqual(await second, { new: { answers: ["current"] } }); fanout.close();
});

for (const kind of ["approval", "input"] as const) for (const change of ["none", "replace", "replace-direct", "remove", "same-object"] as const) {
  test(`INT-04.2: ${kind} lost receipt retains its chosen consumer across ${change}`, async () => {
    const fanout = new NativeInteractionFanout(), chosen = Promise.withResolvers<any>(), late = Promise.withResolvers<any>();
    const results: string[] = [];
    const make = (label: string, value: Promise<any>) => ({ onApproval: () => value, onUserInput: () => value,
      onResult: (_request: unknown, result: string) => { results.push(`${label}:${result}`); },
      onUserInputResult: (_request: unknown, result: string) => { results.push(`${label}:${result}`); } });
    const original = make("chosen", chosen.promise);
    fanout.add("chosen", original); fanout.add("late", make("late", late.promise));
    const answer = kind === "approval" ? fanout.observer.onApproval(approval) : fanout.observer.onUserInput!(input);
    chosen.resolve(kind === "approval" ? "decline" : { question: { answers: ["chosen"] } }); await answer;
    const result = (value: "failed" | "confirmed") => kind === "approval"
      ? fanout.observer.onResult!(approval, value) : fanout.observer.onUserInputResult!(input, value);
    await result("failed"); assert.deepEqual(results, ["chosen:failed", "late:withdrawn"]);
    if (change !== "none") {
      if (change !== "replace-direct") fanout.remove("chosen");
      if (change !== "remove") fanout.add("chosen", change === "same-object" ? original : make("replacement", Promise.resolve("accept")));
    }
    late.resolve(kind === "approval" ? "accept" : { question: { answers: ["late"] } });
    results.length = 0; await result("confirmed");
    assert.equal(results.includes("chosen:confirmed"), change === "none");
    assert.ok(!results.includes("late:confirmed") && !results.includes("replacement:confirmed"));
    fanout.close();
  });
}
