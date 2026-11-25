import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const point of ["during", "after"] as const) {
  test("group audiences survive SIGKILL " + point + " a continuation card on the original turn", {skip:process.platform === "win32"}, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audience-rollover-"));
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const fixture = fileURLToPath(new URL("./fixtures/audience-rollover-crash.mjs", import.meta.url));
    const run = (phase: string) => spawnSync(process.execPath, ["--import","tsx",fixture,root,phase], {encoding:"utf8",timeout:25000});
    const first = run(point);
    assert.equal(first.signal, "SIGKILL", first.stderr);
    const log = () => fs.readFileSync(path.join(root,"channel.jsonl"),"utf8").trim().split("\n").map(row => JSON.parse(row));
    const before = log();
    assert.ok(before.filter(row => row.op === "create").length > 2, "at least one real continuation card was created");
    assert.equal(before.filter(row => row.op === "mention").length, 0);
    for (let i=0;i<2;i++) {
      const result = run("recover");
      assert.equal(result.status, 0, result.stderr);
    }
    const notifications = log().filter(row => row.op === "mention").sort((a,b)=>a.recipientId.localeCompare(b.recipientId));
    const expected = [
      {op:"mention",recipientId:"room-a",actors:["alice","bob"]},
      {op:"mention",recipientId:"room-b",actors:["carol"]}
    ];
    const audienceState = JSON.parse(fs.readFileSync(path.join(root,"audience.json"),"utf8"));
    const remembered = Object.values(audienceState.records).map((r:any) => ({
      op:"mention", recipientId:r.conversationId, actors:r.participants.map((p:any) => p.actorId), turn:r.turnId
    })).sort((a,b)=>a.recipientId.localeCompare(b.recipientId));
    assert.deepEqual(remembered, expected.map(row => ({...row,turn:"original"})));
    if (point === "during") {
      // Creation reached the provider but no recoverable instance receipt came back.
      // Retain each audience and final on its original binding; do not duplicate a card or send a premature @.
      assert.deepEqual(notifications, []);
      assert.equal(log().length, before.length);
      const cursor = JSON.parse(fs.readFileSync(path.join(root,"follow.json"),"utf8"));
      for (const room of ["room-a","room-b"]) {
        assert.equal(cursor[JSON.stringify(["test-account",room])].terminalPending.turnId, "original");
      }
    } else {
      assert.deepEqual(notifications, expected);
    }
  });
}
