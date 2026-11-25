import fs from "node:fs";

/** Owns only files exclusively created for one message. Record ownership
 * before the first write because the filesystem can fail after a partial write. */
export class InboundFileBatch {
  private readonly created: string[] = [];

  write(target: string, bytes: Buffer): void {
    const fd = fs.openSync(target, "wx", 0o600);
    this.created.push(target);
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
  }

  discard(): void {
    for (const file of this.created) {
      try { fs.rmSync(file, { force: true }); } catch { /* Preserve the original transfer failure. */ }
    }
  }
}
