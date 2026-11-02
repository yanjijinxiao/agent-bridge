import fs from "node:fs/promises";
import { constants } from "node:fs";

/** Read one regular file descriptor within the platform limit, even if the
 * producer grows/replaces the path during the asynchronous read. */
export async function readOutboundMedia(filePath: string, maxBytes: number, channel: string): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("媒体上传字节预算必须为正整数。");
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`${channel}媒体发送需要普通文件。`);
    if (!before.size) throw new Error(`${channel}不允许上传空文件。`);
    if (before.size > maxBytes) throw new Error(`${channel}媒体超过上传上限 ${maxBytes} 字节。`);
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("待发送文件仍在变化，请在生成完成后发送。");
    }
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
