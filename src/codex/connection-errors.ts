/** Connection setup and native RPC rejection are different from task failure.
 * Only these bounded fields cross the Connector boundary, never stderr or a
 * provider's error body (which can include credentials or private paths).
 */
export class CodexConnectionSetupError extends Error {
  readonly name = "CodexConnectionSetupError";
  constructor(readonly reason: "socket-unavailable" | "command-unavailable" | "start-timeout" | "start-failed", cause?: unknown) {
    const descriptions = {
      "socket-unavailable": "无法连接本机 Codex 原生服务，请检查该设备的服务和 socket 权限",
      "command-unavailable": "本机 Codex 原生服务未运行，且找不到可用的启动命令，请检查 codexBin 和 Codex 安装",
      "start-timeout": "本机 Codex 原生服务启动超时，请检查该设备的服务状态",
      "start-failed": "本机 Codex 原生服务启动失败，请检查该设备的 codex app-server daemon start 是否可用"
    };
    super(descriptions[reason], { cause });
  }
}

export class CodexNativeRequestError extends Error {
  readonly name = "CodexNativeRequestError";
  constructor(readonly operation: string, readonly rpcCode: number | undefined, detail: string) {
    super(`app-server ${operation} failed${rpcCode === undefined ? "" : ` (${rpcCode})`}: ${detail}`);
  }
  publicMessage(): string {
    return `Codex 原生接口 ${this.operation} 调用失败${this.rpcCode === undefined ? "" : `（错误码 ${this.rpcCode}）`}，请检查该设备的 Codex 服务。`;
  }
}
