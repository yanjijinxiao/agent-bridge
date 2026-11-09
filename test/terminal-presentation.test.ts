import assert from "node:assert/strict";
import test from "node:test";
import { Lexer } from "marked";
import { cleanTerminal, renderTerminalWindow, terminalProse, terminalWindowText, TERMINAL_WINDOW_POINTS } from "../src/channels/terminal-presentation.js";

for (const text of ["a".repeat(20000), "中🧪文".repeat(10000), "[\\`*<&".repeat(10000), "one\n    two\n\tthree\n".repeat(2000)])
test(`terminal tail maximizes escaped byte budget: ${text.slice(0, 8)}`, () => {
 const before="运行中", after="[Web IDE](https://example.test/project)";
 const result=renderTerminalWindow(terminalWindowText(text), 6000, before, after);
 assert.ok(Buffer.byteLength(result)<=6000);assert.ok(Buffer.byteLength(result)>5950);
 assert.ok(result.startsWith(before));assert.ok(result.endsWith(after));assert.doesNotMatch(result,/\ufffd/);
});
test("terminal text retains commands, commentary, status and input without classification", () => {
 const screen="› input\n• Stage text\n• Browsing the web\n• Opened a page\n• Ran test\n  └ command output\n• Working (25s)\n› Ask Codex to do anything";
 assert.equal(renderTerminalWindow(screen,6000),terminalProse(screen));
});
test("overflow discards oldest characters and keeps latest end even for a single huge line", () => {
 const result=renderTerminalWindow("OLD_START"+"中".repeat(20000)+"LATEST_END",1024);
 assert.doesNotMatch(result,/OLD/);assert.ok(result.endsWith("LATEST\\_END"));
 assert.ok(Buffer.byteLength(result)<=1024);assert.ok(Buffer.byteLength(result)>1020);
});
test("terminal escaping preserves line layout without creating controls or rich content", () => {
 const raw='\x1b[31mcolored\x1b[0m\r\n    indented code\n```codex-im-gateway-actions\n{"send":[]}\n```\n![x](https://bad.test)\n<a href="https://bad.test">bad</a>\n1. first\n- list';
 const cleaned=cleanTerminal(raw), safe=terminalProse(cleaned);
 assert.doesNotMatch(safe,/\x1b|\r/);assert.match(safe,/\u00a0{4}indented/);assert.match(safe,/  \n/);
 const tokens:any[]=[];
 const walk=(items:any[])=>{for(const token of items){tokens.push(token);if(token.tokens)walk(token.tokens);if(token.items)walk(token.items);}};
 walk(Lexer.lex(safe));assert.ok(!tokens.some(t=>["code","html","image","link","list"].includes(t.type)),JSON.stringify(tokens));
});
test("empty terminal and oversized trusted regions have explicit behavior", () => {
 assert.equal(renderTerminalWindow("",1024,"state","IDE"),"state\n\nIDE");
 assert.throws(()=>renderTerminalWindow("screen",100,"x".repeat(101)),/budget/);
});
test("durable terminal window is bounded by code points and keeps the newest text", () => {
 const stored=terminalWindowText("OLD"+"🧪".repeat(TERMINAL_WINDOW_POINTS)+"NEW");
 assert.equal(Array.from(stored).length,TERMINAL_WINDOW_POINTS);assert.ok(stored.endsWith("NEW"));assert.doesNotMatch(stored,/OLD|\ufffd/);
});
