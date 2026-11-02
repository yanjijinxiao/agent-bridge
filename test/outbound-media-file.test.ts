import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readOutboundMedia } from "../src/channels/outbound-media-file.js";

for (const change of ["grow", "shrink"]) test(`outbound media rejects ${change} after stat and closes its original descriptor`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-read-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "media.bin"); fs.writeFileSync(file, "1234");
  const open = fsPromises.open; let closed = false, changed = false;
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    return new Proxy(handle, { get(target, key) {
      if (key === "stat") return async () => { const result = await target.stat();
        if (!changed) { changed = true; fs.truncateSync(file, change === "grow" ? 5 : 2); } return result; };
      if (key === "close") return async () => { closed = true; await target.close(); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await assert.rejects(readOutboundMedia(file, 4, "测试渠道"), /变化/);
  assert.equal(closed, true);
});
