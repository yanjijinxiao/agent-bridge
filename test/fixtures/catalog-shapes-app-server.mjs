#!/usr/bin/env node
import readline from "node:readline";

const shape = process.argv[2];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = {};
  else if (request.method === "thread/read") {
    if (process.argv[3] === "lookup") {
      process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32602, message: "thread not found" } })}\n`); continue;
    }
    result = { thread: { id: request.params.threadId, status: { type: "idle" }, projectId: null } };
  }
  else if (["thread/list", "project/list", "model/list", "thread/turns/list"].includes(request.method)) {
    result = shape === "missing" ? { nextCursor: null } : shape === "not-array" ? { data: {} }
      : shape === "bad-cursor" ? { data: [], nextCursor: 42 }
      : shape === "repeated" ? { data: [], nextCursor: "again" } : { data: [], nextCursor: null };
  } else throw new Error(`Unexpected catalog fixture method: ${request.method}`);
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}
