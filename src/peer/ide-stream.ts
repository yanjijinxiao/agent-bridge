import { z } from "zod";
import type { Socket } from "node:net";
import { PeerConnection, PeerError } from "./rpc.js";

export const IDE_STREAM_LIMIT = 64;
const BLOCK = 32 * 1024;
const packet = z.object({ id: z.string().uuid(), seq: z.number().int().nonnegative().safe(),
  kind: z.enum(["data", "end", "close"]), data: z.string().max(Math.ceil(BLOCK / 3) * 4).optional() }).strict();
type Stream = { socket: Socket; guard(): void; sent: number; received: number; receiving: boolean; ended: boolean; tail: Promise<void> };

/** Byte transport only, with one acknowledged block in flight per direction.
 * Targets are installed by the IDE lease owner, never supplied in packets.
 * Socket write completion applies backpressure all the way to the sender. */
export class PeerIDEStreams {
  private readonly streams = new Map<string, Stream>();
  constructor(private readonly connection: PeerConnection) {
    connection.handle("ide.stream", async raw => {
      const parsed = packet.safeParse(raw);
      if (!parsed.success) {
        const id = raw && typeof raw === "object" && "id" in raw ? raw.id : undefined;
        if (typeof id === "string") this.drop(id);
        throw new PeerError("packet", "Invalid IDE stream packet");
      }
      const p = parsed.data, stream = this.streams.get(p.id);
      if (!stream) throw new PeerError("stale", "IDE stream is closed");
      try {
        stream.guard();
        if (p.kind === "close") { this.drop(p.id); return; }
        if (stream.receiving || stream.ended || p.seq !== stream.received++) throw new PeerError("sequence", "IDE stream sequence mismatch");
        if (p.kind === "end") { if (p.data !== undefined) throw new Error("Invalid end"); stream.ended = true; stream.socket.end(); return; }
        if (!p.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)) throw new Error("Invalid block");
        const bytes = Buffer.from(p.data, "base64");
        if (!bytes.length || bytes.length > BLOCK) throw new Error("Invalid block size");
        stream.receiving = true;
        await new Promise<void>((resolve, reject) => {
          const closed = () => done(new Error("IDE stream closed"));
          const timer = setTimeout(() => done(new Error("IDE stream write timed out")), 25000);
          const done = (error?: Error | null) => { clearTimeout(timer); stream.socket.off("close", closed); error ? reject(error) : resolve(); };
          stream.socket.once("close", closed); stream.socket.write(bytes, done);
        });
      } catch (error) { this.drop(p.id); throw error; }
      finally { stream.receiving = false; }
    });
    connection.onClose(() => { for (const id of this.streams.keys()) this.drop(id); });
  }
  add(id: string, socket: Socket, guard: () => void): () => void {
    if (!this.connection.open || this.streams.size >= IDE_STREAM_LIMIT || this.streams.has(id)) {
      socket.destroy(); throw new PeerError("busy", "IDE stream limit reached");
    }
    try { guard(); } catch (error) { socket.destroy(); throw error; } socket.pause();
    const stream: Stream = { socket, guard, sent: 0, received: 0, receiving: false, ended: false, tail: Promise.resolve() }; this.streams.set(id, stream);
    const send = async (kind: "data" | "end", data?: Buffer) => {
      if (this.streams.get(id) !== stream) return;
      guard(); await this.connection.request("ide.stream", { id, seq: stream.sent++, kind, ...(data ? { data: data.toString("base64") } : {}) });
    };
    const failed = () => this.close(id);
    socket.on("data", (data: Buffer) => {
      socket.pause();
      stream.tail = stream.tail.then(async () => {
        for (let offset = 0; offset < data.length; offset += BLOCK) await send("data", data.subarray(offset, offset + BLOCK));
        if (this.streams.get(id) === stream) socket.resume();
      });
      void stream.tail.catch(failed);
    });
    socket.on("end", () => { stream.tail = stream.tail.then(() => send("end")); void stream.tail.catch(failed); });
    socket.on("error", failed);
    socket.on("close", () => { void stream.tail.finally(() => this.close(id)).catch(() => {}); });
    return () => { if (this.streams.get(id) === stream) socket.resume(); };
  }
  close(id: string): void {
    const stream = this.streams.get(id); if (!stream) return;
    this.drop(id);
    void this.connection.request("ide.stream", { id, seq: stream.sent++, kind: "close" }, 5000).catch(() => {});
  }
  private drop(id: string): void { const stream = this.streams.get(id); this.streams.delete(id); stream?.socket.destroy(); }
}
