#!/usr/bin/env node
// Real HTTP/WS endpoint for the transport tests, not a workbench substitute.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
const args = process.argv.slice(2), socket = args[args.indexOf('--socket') + 1];
fs.writeFileSync(path.join(process.cwd(), 'ide-test-process.json'), JSON.stringify({ pid: process.pid, args }));
const server = http.createServer(async (req, res) => {
  if (req.url === '/echo') { req.pipe(res); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ cwd: process.cwd(), url: req.url, headers: req.headers, args }));
});
const ws = new WebSocketServer({ server }); ws.on('connection', s => s.on('message', (bytes, binary) => s.send(bytes, { binary })));
server.listen(socket, () => fs.chmodSync(socket, 0o600));
process.on('SIGTERM', () => { for (const c of ws.clients) c.terminate(); server.closeAllConnections(); server.close(() => process.exit(0)); });
