import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { withIDEEntry } from "../src/ide/completion.js";

const url = "https://ide.example/workspace/project";
const footer = `[打开项目 Web IDE](${url})`;

for (const marker of ["```", "~~~~"]) test(`IDE completion stays clickable outside an unfinished ${marker} example`, () => {
  const source = `${marker}text\nunfinished example`;
  const result = withIDEEntry(source, url);
  assert.equal(result, `${source}\n${marker}\n\n${footer}`);
  assert.equal(Lexer.lex(result).at(-1)?.type, "paragraph");
  assert.equal(withIDEEntry(result, url), result);
});

test("a URL in a literal example does not suppress the actual IDE footer", () => {
  const source = `\`\`\`text\nReference only: ${url}\n\`\`\``;
  assert.equal(withIDEEntry(source, url), `${source}\n\n${footer}`);
  assert.equal(withIDEEntry(withIDEEntry(source, url), url), `${source}\n\n${footer}`);
});

test("an apparent fence with a nonempty suffix does not turn a literal IDE example into a removable footer", () => {
  const source = `\`\`\`md\n\`\`\`not-a-close\n${footer}\n\`\`\``;
  assert.equal(withIDEEntry(source), source);
  assert.equal(withIDEEntry(`    ${footer}`), `    ${footer}`);
  assert.equal(withIDEEntry(`    ${footer}`, url), `    ${footer}\n\n${footer}`);
});
