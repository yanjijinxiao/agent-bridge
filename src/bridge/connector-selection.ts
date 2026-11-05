import { randomUUID } from "node:crypto";
import type { PeerBridgePort, PeerPrincipal } from "../peer/context.js";
import type { RuntimeStateStore } from "../state/runtime-state.js";

export class ConnectorSelectionError extends Error {}
const TTL = 15 * 60_000;
type Snapshot = { id: string; createdAt: number; hosts: string[] };

/** Catalog preference, not execution routing or authority. Grants stay in PeerRegistry. */
export class ConnectorSelection {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly store: RuntimeStateStore, private readonly peer?: PeerBridgePort) {}

  private key(principal: PeerPrincipal): string { return JSON.stringify([principal.accountId, principal.conversationId, principal.actorId]); }

  list(principal: PeerPrincipal): Snapshot {
    for (const [key, value] of this.snapshots) if (Date.now() - value.createdAt > TTL) this.snapshots.delete(key);
    const snapshot = { id: randomUUID(), createdAt: Date.now(), hosts: [...this.peer?.hosts(principal) ?? []] };
    this.snapshots.set(this.key(principal), snapshot);
    return snapshot;
  }

  select(principal: PeerPrincipal, selector: string, card = false): string {
    const match = /^C([1-9]\d*)(?:@([a-f0-9-]{36}))?$/i.exec(selector);
    const snapshot = this.snapshots.get(this.key(principal));
    if (!match || !snapshot || Date.now() - snapshot.createdAt > TTL || card && !match[2]
      || match[2] && match[2] !== snapshot.id)
      throw new ConnectorSelectionError("设备列表已过期或已刷新，请发送 /connect 后重新选择。");
    const host = snapshot.hosts[Number(match[1]) - 1];
    if (!host) throw new ConnectorSelectionError("没有这个设备编号，请发送 /connect 查看。");
    this.assertAuthorized(principal, host);
    // Offline selection is allowed and retained; actual queries report offline.
    this.store.setConnectorSelection(principal, host);
    return host;
  }

  assertAuthorized(principal: PeerPrincipal, host: string): void {
    if (host.startsWith("peer:") && !this.peer?.hosts(principal).includes(host))
      throw new ConnectorSelectionError("所选 Connector 的授权已失效，未切换其他设备。请发送 /connect 重新选择或配对。");
  }

  assertAvailable(principal: PeerPrincipal, host: string): void {
    this.assertAuthorized(principal, host);
    if (host.startsWith("peer:") && this.peer?.isOnline?.(host) === false)
      throw new ConnectorSelectionError(`当前 Connector「${this.peer.label(host)}」离线，已保留选择，未切换其他设备。`);
  }

  resolve(principal: PeerPrincipal): string | undefined {
    let selected = this.store.getConnectorSelection(principal)?.hostId;
    if (!selected) {
      const hosts = this.peer?.hosts(principal) ?? [];
      if (hosts.length > 1) throw new ConnectorSelectionError("有多个已授权 Connector，请发送 /connect 选择当前设备；查看全部可用 /sessions all。");
      if (hosts.length === 1) { selected = hosts[0]; this.store.setConnectorSelection(principal, selected); }
    }
    if (selected) this.assertAvailable(principal, selected);
    return selected;
  }

  /** Persisted generation fences in-flight A→B→A queries without touching tasks. */
  guard(principal: PeerPrincipal): () => void {
    const revision = this.store.getConnectorSelection(principal)?.revision;
    return () => {
      if (this.store.getConnectorSelection(principal)?.revision !== revision)
        throw new ConnectorSelectionError("查询期间当前 Connector 已改变，请刷新列表；原会话绑定未改变。");
    };
  }
}
