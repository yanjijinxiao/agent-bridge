import assert from "node:assert/strict";
import test from "node:test";
import { parsePrompt } from "../src/bridge/format.js";

const marker = "[DingTalk file: example.txt saved to /tmp/example.txt]\nInspect the saved local attachment before answering.";
for (const literal of [
  `\`\`\`text\n${marker}\n\n\n<image path="/tmp/example.png"></image>\n\`\`\``,
  marker.split("\n").map(line => `> ${line}`).join("\n"),
  `- 示例：\n\n  \`\`\`text\n${marker.split("\n").map(line => `  ${line}`).join("\n")}\n  \`\`\``
]) test(`displayed history preserves inert attachment source examples: ${literal[0]}`, () => {
  assert.deepEqual(parsePrompt(literal), { text: literal, attachments: [] });
});

test("a real top-level attachment is extracted without consuming an earlier fenced example", () => {
  const example = `\`\`\`text\n${marker}\n\`\`\``;
  assert.deepEqual(parsePrompt(`${example}\n\n${marker}`), { text: example,
    attachments: [{ source: "DingTalk", kind: "file", label: "example.txt", path: "/tmp/example.txt" }] });
});

test("Desktop attachment envelopes strip real image metadata while retaining the same tag in a fenced example", () => {
  const tag = '<image path="/tmp/example.png"></image>', example = `\`\`\`html\n${tag}\n\`\`\``;
  assert.deepEqual(parsePrompt(`# Files mentioned by the user:\n\n## attachment.png: /tmp/example.png\n\n## My request:\n${example}\n\n${tag}`),
    { text: example, attachments: [] });
});
