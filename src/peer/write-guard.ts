import type { CodexWriteGuard } from "../codex/write-guard.js";
import { CodexCommunicationError } from "../codex/communication-error.js";
import type { PeerConnection } from "./rpc.js";

/** A live socket is not proof that the original chat/actor still authorizes a
 * write. Ask the original operation's guard again at each native boundary. */
export function peerWriteGuard(connection: PeerConnection, operationId: string, method: string, local: () => void): CodexWriteGuard {
  const guard = () => {
    local();
    if (!connection.open) throw new CodexCommunicationError("preflight", method);
  };
  return Object.assign(guard, { beforeWrite: async () => {
    guard();
    try { await connection.request("execution.callback", { operationId, name: "assertCurrent", args: [] }); }
    catch { throw new CodexCommunicationError("preflight", method); }
    guard();
  } });
}
