import assert from "node:assert/strict";
import test from "node:test";
import { importNativeIDEProfile, parseIDEJSONC, nativeSettingsSchema, extensionListSchema } from "../src/ide/native-profile.js";

test("native JSONC preserves URLs, escaped strings, comments and trailing comma semantics", () => {
  assert.deepEqual(parseIDEJSONC('\uFEFF// header\n{ "url": "https://example/a/*b*/,}", /* comment */ "list": [1,], "quote": "\\\"//", }'),
    { url: "https://example/a/*b*/,}", list: [1], quote: '"//' });
  for (const value of ['{/* unfinished', '{"a":1,,}', '{"a":"unterminated}', 'undefined', '{a:1}']) assert.throws(() => parseIDEJSONC(value));
});

test("native settings support arbitrary extension keys, language overrides and nested JSON", () => {
  const settings = { "gitlens.currentLine.enabled": true, "gitlens.autolinks": [{ prefix: "OPS-", url: "https://issues.test/<num>" }],
    "[typescript]": { "editor.defaultFormatter": "esbenp.prettier-vscode" }, "editor.rulers": [80, 120], "window.autoDetectHighContrast": false };
  assert.deepEqual(importNativeIDEProfile({ kind: "settings", content: JSON.stringify(settings) }), { settings, warnings: [] });
  for (const value of [[], null, JSON.parse('{"__proto__":{"polluted":true}}'), { k: { constructor: "bad" } }, { x: NaN }])
    assert.equal(nativeSettingsSchema.safeParse(value).success, false);
  assert.equal(({} as any).polluted, undefined);
});

test("extensions.json imports arbitrary publisher IDs but excludes unwanted recommendations", () => {
  assert.deepEqual(importNativeIDEProfile({ kind: "extensions", content: '{"recommendations":["eamodio.gitlens","redhat.java"],"unwantedRecommendations":["redhat.java"],}' }).extensions,
    ["eamodio.gitlens"]);
  for (const ids of [["--install-extension"], ["https://example/a.vsix"], ["../a.vsix"], ["a.b@1.0.0"], ["a.b", "A.B"]])
    assert.equal(extensionListSchema.safeParse(ids).success, false);
});

test("exported Profile imports only selected fields and explicitly reports disabled or unhandled content", () => {
  const result = importNativeIDEProfile({ kind: "profile", content: JSON.stringify({ name: "Work",
    settings: '{// keep syntax\n"gitlens.hovers.enabled":true,}',
    extensions: JSON.stringify([{ identifier: { id: "eamodio.gitlens", uuid: "metadata" }, version: "17.0.0" },
      { identifier: { id: "redhat.java" }, disabled: true }]), keybindings: "[]", snippets: "{}" }) });
  assert.deepEqual(result.settings, { "gitlens.hovers.enabled": true }); assert.deepEqual(result.extensions, ["eamodio.gitlens"]);
  assert.equal(result.warnings.length, 4);
  assert.match(result.warnings.join(" "), /keybindings.*snippets.*禁用.*版本/);
  assert.equal(importNativeIDEProfile({ kind: "profile", content: '{"name":"Extensions only", "extensions":"[]"}' }).settings, undefined);
  assert.throws(() => importNativeIDEProfile({ kind: "profile", content: '{"name":"Empty"}' }), /没有/);
});
