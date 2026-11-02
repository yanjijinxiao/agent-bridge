import http from "node:http";
import os from "node:os";

export function firstNonLoopbackAddress() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(?:utun|tun|tap|wg)/.test(name))
    .flatMap(([, entries]) => entries)
    .find(entry => entry?.family === "IPv4" && !entry.internal)?.address ?? null;
}

// Real TCP peer identity exercises loopback restrictions separately from Host
// admission. The destination stays on this fixture's loopback listener; a VPN
// endpoint or a corporate non-RFC1918 Host cannot mask the intended assertion.
export function fetchFromNonLoopback(url, sourceAddress, options = {}) {
  const target = new URL(url);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") throw Error("Fixture destination must be loopback HTTP");
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      localAddress: sourceAddress, method: options.method ?? "GET", headers: { ...options.headers, host: `localhost:${target.port}` } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined)) })));
    });
    request.setTimeout(5000, () => request.destroy(Error("Non-loopback fixture deadline")));
    request.on("error", reject); request.end(options.body);
  });
}
