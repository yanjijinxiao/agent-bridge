import assert from "node:assert/strict";
import test from "node:test";
import { layoutTerminals, verifiedAppSpaces } from "../src/agents/herdr/app-layout.js";
const block = (id: string) => ({ type: "block", content: { terminal: id } });
test("App layout reads explicit terminal blocks and floats, never mod content or a global agent selector", () => {
  const root = { type: "column", children: [block("t1"), { type: "block", content: { mod: "untrusted", props: { terminal: "wrong" } } },
    { type: "block", content: { agent: "focused" } }], floating: [{ content: { terminal: "t2" } }] };
  assert.deepEqual(layoutTerminals(root), ["t1", "t2"]);
});
test("App layout bounds recursion and rejects unknown node semantics", () => {
  let root: object = block("t1"); for (let i = 0; i < 65; i++) root = { type: "row", children: [root] };
  assert.throws(() => layoutTerminals(root), /限制/); assert.throws(() => layoutTerminals({ type: "custom", terminal: "t1" }), /不兼容/);
});
const window = { spaces: [{ id: "s1", name: "Space", folder: "/actual", machine: null, tabs: [{ terminals: [{ terminal: "t1" }] }] }] };
const document = { version: 1, value: { spaces: [{ id: "s1", name: "Space", folder: "/actual", tabs: [{ root: block("t1") }] }] } };
test("window/core matching establishes membership through the pinned core document", async () => {
  const result = await verifiedAppSpaces({ close() {}, async request(method, params) {
    assert.equal(method, "doc.get"); assert.deepEqual(params, { name: "herdr-app", on: null }); return document;
  } }, window);
  assert.equal(result.warnings.length, 0); assert.equal(result.spaces[0].folder, "/actual");
});
for (const field of ["folder", "terminal", "missing"] as const) test(`window/core mismatch ${field} cannot grant project directories`, async () => {
  const doc = structuredClone(document);
  if (field === "folder") doc.value.spaces[0].folder = "/another";
  if (field === "terminal") doc.value.spaces[0].tabs[0].root.content.terminal = "other";
  if (field === "missing") doc.value.spaces = [];
  const result = await verifiedAppSpaces({ close() {}, async request() { return doc; } }, window);
  assert.equal(result.spaces[0].name, "Space"); assert.equal(result.spaces[0].folder, ""); assert.deepEqual(result.spaces[0].tabs, []);
  assert.equal(result.warnings.length, 1);
});
test("a remote layout failure cannot remove the verified local project", async () => {
  const raw = { spaces: [...window.spaces, { ...window.spaces[0], id: "remote/s1", machine: "remote", tabs: [{ terminals: [{ terminal: "remote/t1" }] }] }] };
  const result = await verifiedAppSpaces({ close() {}, async request(_method, params) {
    if ((params as any).on === "remote") throw Error("remote offline"); return document;
  } }, raw);
  assert.equal(result.spaces.length, 2); assert.equal(result.spaces[0].folder, "/actual"); assert.equal(result.spaces[1].folder, "");
});
test("remote membership qualifies IDs exactly once against its own document", async () => {
  const raw = { spaces: [{ ...window.spaces[0], id: "machine/s1", machine: "machine", tabs: [{ terminals: [{ terminal: "machine/t1" }] }] }] };
  const result = await verifiedAppSpaces({ close() {}, async request(_method, params) {
    assert.equal((params as any).on, "machine"); return document;
  } }, raw);
  assert.equal(result.warnings.length, 0);
});
