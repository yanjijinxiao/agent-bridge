import type { Server } from "node:http";
import type { Socket } from "node:net";

/** Retire only this HTTP server's sockets. Node's server.close() can wait
 * forever for an incomplete request (even before the request event fires).
 * Give existing responses a short drain window, then close remaining sockets;
 * do not signal an executor or replay a mutation whose response was lost. */
export function trackHTTPShutdown(server: Server, graceMs = 5000): () => Promise<void> {
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let socketClosed = () => {};
  const connected = (socket: Socket) => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => { sockets.delete(socket); socketClosed(); });
  };
  server.on("connection", connected);
  return () => closing ??= new Promise<void>((resolve, reject) => {
    let serverClosed = false, closeError: Error | undefined;
    const finish = () => {
      if (!serverClosed || sockets.size) return;
      clearTimeout(timer); server.off("connection", connected); socketClosed = () => {};
      closeError ? reject(closeError) : resolve();
    };
    socketClosed = finish;
    const timer = setTimeout(() => {
      // Includes accepted sockets with partial headers and upgraded sockets,
      // which closeIdleConnections / closeAllConnections alone can miss.
      for (const socket of sockets) socket.destroy();
    }, graceMs);
    timer.unref();
    server.close(error => {
      serverClosed = true; closeError = error; finish();
    });
    server.closeIdleConnections();
  });
}
