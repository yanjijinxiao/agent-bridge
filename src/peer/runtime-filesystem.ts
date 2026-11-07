import { RuntimeResourceCatalog, bindingResourceRef } from "../agents/resource-catalog.js";
import { RuntimeError } from "../agents/contracts.js";
import { INBOUND_FILE_RECEIVER, stageFilesUsingCommand } from "../codex/inbound-files.js";
import { OUTPUT_FILE_SENDER, fetchOutputUsingCommand } from "../codex/output-files.js";
import type { CodexBridgeBackend } from "../codex/backend.js";
import type { ScriptHost } from "../hosts/script-host.js";
import { PeerError } from "./rpc.js";
export type PeerFileTransport = Pick<CodexBridgeBackend, "stageAttachments" | "fetchOutputFile"> & { filesystemId?: string };

/** All filesystem consumers resolve the same resource-owned host. Directory
 * text alone is never enough to select the Connector's local filesystem. */
export class RuntimeFilesystem {
  constructor(private readonly catalog: RuntimeResourceCatalog) {}
  async host(threadId: string): Promise<ScriptHost | undefined> {
    try { return await this.resolveHost(threadId); }
    catch (error) {
      if (error instanceof RuntimeError) throw new PeerError("runtime", error.message, { code: error.code, submission: error.submission });
      throw error;
    }
  }
  private async resolveHost(threadId: string): Promise<ScriptHost | undefined> {
    const ref = bindingResourceRef(threadId, this.catalog.descriptor.endpointId);
    const resource = await this.catalog.runtime.inspect(ref);
    if (!resource.machine) return undefined;
    const host = await this.catalog.runtime.fileHost?.(ref);
    if (!host) throw new RuntimeError("unsupported", "此资源位于远端，但执行入口没有提供该机器的文件通道；未访问本机同名路径。");
    return host;
  }
  async files(threadId: string, assertCurrent: () => void): Promise<PeerFileTransport | undefined> {
    const host = await this.host(threadId); if (!host) return;
    return {
      filesystemId: host.id,
      stageAttachments: async (files, options) => {
        const result = await stageFilesUsingCommand(files, JSON.stringify([host.id, options.scope]), options.maxBytes, () => host.command(INBOUND_FILE_RECEIVER), assertCurrent);
        await host.verify(); assertCurrent();
        if ((await this.host(threadId))?.id !== host.id) throw new RuntimeError("changed", "传输期间文件主机改变");
        return result;
      },
      fetchOutputFile: async (file, options) => {
        const lease = await fetchOutputUsingCommand(file, options, () => host.command(OUTPUT_FILE_SENDER), assertCurrent);
        try {
          await host.verify(); assertCurrent();
          if ((await this.host(threadId))?.id !== host.id) throw new RuntimeError("changed", "传输期间文件主机改变");
          return lease;
        } catch (error) { await lease.dispose(); throw error; }
      }
    };
  }
}
