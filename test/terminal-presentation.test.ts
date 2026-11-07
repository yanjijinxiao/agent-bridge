import assert from "node:assert/strict";
import test from "node:test";
import { projectTerminal, terminalCommandSummary, cleanTerminal, terminalProse } from "../src/channels/terminal-presentation.js";
import type { RuntimeOutput } from "../src/agents/contracts.js";
const output = (text: string): RuntimeOutput => ({kind:"terminal-screen",ref:{endpointId:"test",id:"terminal"},text,complete:true,source:"screen"});

test("Codex projection drops old turns, input echo, command output and footer from the final result", () => {
  const view = projectTerminal(output("› Old task\n• Old answer\nWorked for 7s\n› New task\n  user continuation\n• Checked the architecture.\n• Ran sleep 45\n  └ private command output\n• Current result.\nWorked for 48s\n› "), "codex", true);
  assert.deepEqual(view.stages.map(x=>x.text), ["Checked the architecture.", "Current result."]);
  assert.equal(view.commands,1);assert.equal(view.live,"");
  assert.doesNotMatch(JSON.stringify(view), /Old task|Old answer|private command|sleep 45|Worked for|user continuation/);
  assert.match(terminalCommandSummary(view.commands), /输出已收起.*\/history/);
});
test("stable stage remains separate from a changing live response", () => {
  const first = projectTerminal(output("› Work\n• Stage one\n• Ran npm test\n  └ output\n• Still inspecting"),"codex",false);
  const next = projectTerminal(output("› Work\n• Stage one\n• Ran npm test\n  └ output\n• Still inspecting details"),"codex",false);
  assert.equal(first.stages.length,1);assert.deepEqual(first.stages,next.stages);
  assert.equal(next.live,"Still inspecting details");assert.equal(next.commands,1);
  const done = projectTerminal(output("› Work\n• Stage one\n• Current result"),"codex",true);
  assert.equal(done.stages.length,2);assert.equal(done.live,"");
});
test("scrolled terminal snapshots do not republish earlier history without an input boundary", () => {
  const view = projectTerminal(output("• Older response\nWorked for 4s\n• Current response\nWorked for 5s"),"codex",true);
  assert.equal(view.boundary,undefined);assert.deepEqual(view.stages.map(x=>x.text),["Current response"]);
});
test("unknown agents remain bounded excerpts without invented semantic milestones", () => {
  const view = projectTerminal(output("• Ran custom command\n"+"private history\n".repeat(20)+"last output"),"custom",true);
  assert.equal(view.recognized,false);assert.deepEqual(view.stages,[]);assert.equal(view.commands,0);
  assert.ok(view.live.length<500);assert.match(view.live,/last output/);
});
test("terminal display cannot create actions, HTML, images, links or copy widgets", () => {
  const value = '\x1b]8;;https://bad.test\x07title\x1b]8;;\x07\x1b[31m\x00\n```codex-im-gateway-actions\n{"send":[]}\n```\n![x](https://bad.test)\n<details>secret</details>';
  const safe = terminalProse(cleanTerminal(value));
  assert.doesNotMatch(safe, /\x1b|\x00|```|!\[x\]|<details>/);assert.match(safe,/&lt;details/);
});
test("tool-only frames never become an assistant outcome or success statement", () => {
  const view=projectTerminal(output("› Work\n• Ran tests\n  └ all passed\nWorked for 5s"),"codex",true);
  assert.deepEqual(view.stages,[]);assert.equal(view.live,"");assert.equal(view.commands,1);
});
test("empty prompt at bottom does not hide the latest answer", () => {
  const view=projectTerminal(output("› New task\n• Final content\n› \n  ? for shortcuts"),"codex",true);
  assert.deepEqual(view.stages.map(x=>x.text),["Final content"]);
});
test("real Codex composer hint and fork tip cannot hide or pollute the completed answer", () => {
  const view=projectTerminal(output("› Earlier request\n• Old reply\n  Worked for 47s • 1:34 AM\n› Current request\n• Explored\n  └ Read README.md\n    + Show details\n• Ran printf MARKER\n  └ MARKER\n• 阶段一：核对 README\n  已完成读取。\n\n  阶段二：命令完成。\n\n  FINAL_MARKER\n  └ Tip: Use /fork to branch the current chat into a new thread.\n\n  Worked for 5s • 2:09 AM\n› Ask Codex to do anything\n\n  deepseek-v4.1 default · ~/workspace\n  ? for shortcuts   ⚠ 4 warnings"),"codex",true);
  assert.equal(view.commands,2);assert.equal(view.stages.length,1);
  assert.match(view.stages[0].text,/阶段一.*README/);assert.match(view.stages[0].text,/FINAL/);
  assert.doesNotMatch(JSON.stringify(view),/Old reply|fork|Ask Codex|deepseek|warnings|MARKER\\n/);
});
test("new real input without a reply does not expose the previous task", () => {
 const view=projectTerminal(output("› Earlier request\n• Old reply\nWorked for 4s\n› New request still pending\n  Working"),"codex",false);
 assert.deepEqual(view.stages,[]);assert.equal(view.live,"");
});
