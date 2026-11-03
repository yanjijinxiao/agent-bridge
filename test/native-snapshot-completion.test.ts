import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { CodexTurnExecutionError } from "../src/codex/backend.js";

for (const mode of ["completed", "failed", "interrupted", "system-error", "unloaded", "active", "other-turn", "newer-start", "missing-items", "unloaded-items"]) {
  test(`native snapshot reconciles only the exact inactive owner turn (${mode})`, async t => {
    const runner = new AppServerCodexRunner({requestTimeoutMs:1000,transport:{mode:"remote-daemon",command:process.execPath,
      args:[fileURLToPath(new URL("./fixtures/snapshot-completion.mjs",import.meta.url)),mode]}});
    t.after(() => runner.close());
    let accepted!: () => void, settled = false;
    const started = new Promise<void>(resolve => {accepted=resolve;});
    const pending = runner.run({cwd:"/tmp",prompt:"one original input",onTurnStarted(){accepted();}})
      .then(result => {settled=true; return result;}, error => {settled=true; return error as Error;});
    await started;
    const terminal = ["completed","failed","interrupted","system-error"].includes(mode);
    if (terminal) {
      assert.equal((await runner.inspectThread("thread")).runtimeStatus,mode === "system-error" ? "systemError" : "idle");
      assert.equal(settled,false,"metadata alone must not settle the run and discard its final answer");
    }
    const snapshot = await runner.readThreadSnapshot("thread");
    await new Promise(resolve => setImmediate(resolve));
    if (terminal) {
      assert.equal(snapshot.state.runtimeStatus,mode === "system-error" ? "systemError" : "idle");
      assert.equal(snapshot.state.activeTurnId,undefined);
      // Completing run also releases its subscription over JSONL; one
      // setImmediate is not an acknowledgement that this final RPC arrived.
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([pending, new Promise<never>((_, reject) => {
        timer=setTimeout(() => reject(Error("exact native receipt did not finish the original run")),1000);
      })]).finally(() => clearTimeout(timer));
      if (mode === "completed") {assert.ok(!(result instanceof Error));assert.equal(result.text,"EXACT_RESULT");}
      else {assert.ok(result instanceof CodexTurnExecutionError);assert.equal(result.status,mode === "system-error" ? "failed" : mode);}
    } else {
      // Drain an additional JSONL round trip so a wrongly settled run has
      // time to finish its unsubscribe; checking one microtask can false-pass.
      await runner.inspectThread("thread", {includeTurns:false,timeoutMs:1000});
      assert.equal(settled,false,"unloaded, contradictory or foreign evidence must not end the original run");
      if (mode === "newer-start") {assert.equal(snapshot.state.runtimeStatus,"active");assert.equal(snapshot.state.activeTurnId,"newer");}
    }
    await runner.close(); await pending;
  });
}
