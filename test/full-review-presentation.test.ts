import assert from "node:assert/strict";
import test from "node:test";
import { presentAssistantText, projectAssistantProse } from "../src/channels/assistant-presentation.js";
import { dingTalkPlainText, normalizeDingTalkCardContent } from "../src/channels/dingtalk-markdown.js";
import { summarizeProgress } from "../src/channels/progress-summary.js";
import { completedCardForMentions } from "../src/channels/completion-mentions.js";
import { parseActionBlocks } from "../src/bridge/actions.js";

const directive = '::code-comment{title="finding" body="body" file="/work/file.ts" start=1}';
for (const newline of ["\r\n", "\r"]) test(`Markdown projection keeps protected original bytes for ${JSON.stringify(newline)} input`, () => {
  for (const source of [`\`\`\`text${newline}${directive}${newline}\`\`\``, `> ${directive}${newline}> quoted`,
    `paragraph \`${directive}\`${newline}tail`]) {
    assert.equal(presentAssistantText(source), source);
    assert.equal(projectAssistantProse(source, text => text.replaceAll("finding", "changed")), source);
  }
  const source = `\`\`\`text${newline}literal${newline}\`\`\`${newline}${newline}${directive}`;
  const result = presentAssistantText(source);
  assert.ok(result.startsWith(`\`\`\`text${newline}literal${newline}\`\`\``));
  assert.ok(!result.slice(result.indexOf("literal") + 7).includes(directive));
});
test("plain DingTalk transport unwraps CRLF fenced exact replies without exposing code wrappers", () => {
  const command = "/approve A1 accept";
  assert.equal(dingTalkPlainText(`说明\r\n\r\n\`\`\`text\r\n${command}\r\n\`\`\``), `说明\r\n\r\n${command}`);
});

test("review annotations retain distinct locations and identifiers while repeated findings appear once", () => {
  const note = (file: string, line: number, body: string) =>
    `::code-comment{title="Review" body=${JSON.stringify(body)} file="/repo/src/${file}" start=${line}}`;
  const a = note("a.ts", 4, "Check user_id.");
  const b = note("b.ts", 8, "Check user_id.");
  const c = note("b.ts", 11, "Check userid.");
  const rendered = presentAssistantText([a, b, a, c].join("\n\n"));
  for (const location of ["src/a.ts:4", "src/b.ts:8", "src/b.ts:11"]) {
    assert.equal(rendered.split(location).length - 1, 1, location);
  }
  assert.equal(rendered.split("Check user_id.").length - 1, 1);
  assert.equal(rendered.split("Check userid.").length - 1, 1);
  const range = '::code-comment{title="Review" body="Check the key." file="/repo/src/c.ts" start=3 end=5}';
  assert.match(presentAssistantText("Check the key.\n\n" + range), /src\/c\.ts:3–5/);
  assert.equal(presentAssistantText("Check the key.\n\n" + range).split("Check the key.").length - 1, 1);
});

test("progress, final mention card and text fallback retain each distinct review location", () => {
  const raw = [4, 8].map(line =>
    '::code-comment{title="Review" body="Check the key." file="/repo/src/a.ts" start=' + line + '}'
  ).join("\n\n");
  const { actions, visibleText } = parseActionBlocks(raw);
  assert.deepEqual(actions, { send: [], control: [] });
  const card = completedCardForMentions({
    startedAt: 1, progressEntries: [raw], thought: "", answerPreview: "", finished: true,
    resultPresentation: "card", messageId: "sent", statusHeader: true,
    terminal: { text: visibleText, error: false }, terminalPages: [{ messageId: "sent", delivered: true }]
  });
  assert.ok(card);
  for (const text of [summarizeProgress(raw), normalizeDingTalkCardContent(card.text), dingTalkPlainText(visibleText)]) {
    for (const at of ["src/a.ts:4", "src/a.ts:8"]) assert.equal(text.split(at).length - 1, 1);
    assert.equal(text.split("Check the key.").length - 1, 1);
    assert.doesNotMatch(text, /::code-comment/);
  }
});
