import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// Optional deployment front for a single fixed HTTPS entrance. Authentication
// stays at the two loopback services; no management API is published here.
export function createPeerIDEFront({ key, cert, peerPort, idePort }) {
  const idePath = url => /^\/(?:workspace|open|logout|approval)\/[a-f0-9]{32}(?:\?.*)?$/.test(url)
    || /^\/ide\/[a-f0-9]{32}\/[^\r\n]*$/.test(url);
  const server = https.createServer({ key, cert }, (req, res) => {
    const workspace = idePath(req.url ?? ''), authorize = req.url === '/authorize' && req.method === 'POST';
    if ((!workspace && !authorize) || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) { res.writeHead(404).end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: idePort, method: req.method, path: req.url, headers: req.headers }, result => {
      res.writeHead(result.statusCode ?? 502, result.headers); result.pipe(res);
    });
    upstream.setTimeout(240000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end('IDE unavailable'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('upgrade', (req, client, head) => {
    const peer = req.url === '/gateway/v1/peer' && !req.headers.origin;
    const ide = /^\/ide\/[a-f0-9]{32}\//.test(req.url ?? '');
    if ((!peer && !ide) || req.method !== 'GET') { client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const upstream = net.connect(peer ? peerPort : idePort, '127.0.0.1');
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close);
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    upstream.once('connect', () => {
      const headers = []; for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.PEER_TLS_ROOT ?? '/home/admin/gateway-connector-linux-test';
  const port = (name, fallback) => { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Invalid listener port'); return value; };
  const server = createPeerIDEFront({ key: fs.readFileSync(root + '/gateway-key.pem'), cert: fs.readFileSync(root + '/gateway-ca.pem'),
    peerPort: port('PEER_BACKEND_PORT', 19478), idePort: port('IDE_BACKEND_PORT', 28480) });
  server.listen(port('PEER_TLS_PORT', 80), '0.0.0.0', () => console.log('Peer and project IDE TLS front ready'));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
