/** Runtime facts are independent of the channel, transport and agent brand.
 * A terminal write is deliberately not a native conversation receipt. */
export type RuntimeKind = "codex" | "herdr-tui" | "herdr-app";
export type RuntimeOperation = "catalog" | "inspect" | "read" | "send" | "interrupt" | "create" | "rename"
  | "archive" | "delete" | "native-steer" | "native-queue" | "models" | "settings" | "goal" | "usage" | "interaction" | "structured-output";
export type RuntimeSupport = { supported: true; semantics: string }
  | { supported: false; reason: string; availability?: "native-unavailable" | "not-adapted" | "configuration-required" };
export type RuntimeDescriptor = {
  kind: RuntimeKind;
  /** Configuration identity, not a display name or a process id. */
  endpointId: string;
  serverId?: string;
  version: string;
  protocol: { name: string; generation?: number };
  operations: Record<RuntimeOperation, RuntimeSupport>;
};
export type ResourceRef = { endpointId: string; id: string };
export type RuntimeState = "idle" | "working" | "blocked" | "done" | "error" | "exited" | "unknown";
export type RuntimeResource = {
  ref: ResourceRef;
  kind: "terminal" | "conversation";
  title: string;
  projectId?: string;
  cwd?: string;
  /** Files belong to this machine; undefined means the configured local endpoint. */
  machine?: string;
  agent?: string;
  state: RuntimeState;
  evidence: "native-lifecycle" | "program-report" | "terminal-detection" | "process-exit" | "unknown";
  /** Best observed identity; no adapter may claim an atomic native compare-and-write without one. */
  incarnation?: string;
  identityStrength: "native" | "observed" | "unknown";
  observationSequence?: number;
  blockedKind?: string;
};
export type RuntimeProject = { id: string; name: string; roots: string[]; machine?: string };
export type RuntimeCatalog = { projects: RuntimeProject[]; resources: RuntimeResource[]; complete: boolean; warnings: string[] };
export type RuntimeOutput = {
  kind: "terminal-screen";
  ref: ResourceRef;
  text: string;
  complete: boolean;
  /** Terminal content is untrusted display data, never an assistant final/action block. */
  source: "screen" | "recent";
};
export type RuntimeHandoff =
  | { kind: "native-accepted"; ref: ResourceRef; messageId?: string; turnId: string }
  | { kind: "terminal-written"; ref: ResourceRef; incarnation: string; started: boolean | null; observationSequence?: number };
/** Final authorization reads current in-memory binding/grant state. It must be
 * synchronous so connecting the socket cannot leave a stale authorization
 * between an await and the actual write. Async preparation belongs upstream. */
export type RuntimeWrite = { target: RuntimeResource; assertCurrent: () => void;
  /** Revalidate the originating channel across transport after socket connect.
   * The final synchronous guard still runs after this await. */
  prepareWrite?: () => Promise<void> };
export type RuntimeInterrupt = { kind: "interrupt-requested" | "not-active"; ref: ResourceRef;
  observation?: "stopped" | "exited" | "still_working" | "unknown" };

/** Creation is an explicit launch, never an empty conversational turn. A
 * program means the adapter's public launch name, not a shell command line. */
export type RuntimeCreate = {
  cwd: string; title: string; program: string; args: string[]; projectId?: string;
  assertCurrent: () => void; prepareWrite?: () => Promise<void>;
  /** Persist the topology receipt BEFORE starting its program. */
  onCreated: (ref: ResourceRef) => void;
};
export type RuntimeLifecycleResult =
  | { kind: "created" | "renamed"; resource: RuntimeResource }
  | { kind: "closed"; ref: ResourceRef; scope: "terminal-process" | "pane" };

/** Protocol adapters do not own source journals or retries. Their caller must
 * durably record write intent before calling send/interrupt. */
export interface AgentRuntimeAdapter {
  /** Optional remote filesystem transport resolved from this exact resource.
   * Undefined means the resource is local; a remote resource must never fall
   * back to the Connector's filesystem when this port is absent. */
  fileHost?(ref: ResourceRef): Promise<import("../hosts/script-host.js").ScriptHost | undefined>;
  describe(): Promise<RuntimeDescriptor>;
  catalog(): Promise<RuntimeCatalog>;
  inspect(ref: ResourceRef): Promise<RuntimeResource>;
  read(ref: ResourceRef): Promise<RuntimeOutput>;
  send(input: RuntimeWrite & { text: string }): Promise<RuntimeHandoff>;
  interrupt(input: RuntimeWrite): Promise<RuntimeInterrupt>;
  create?(input: RuntimeCreate): Promise<RuntimeResource>;
  rename?(input: RuntimeWrite & { title: string }): Promise<RuntimeResource>;
  closeResource?(input: RuntimeWrite): Promise<Extract<RuntimeLifecycleResult, { kind: "closed" }>>;
  close(): void;
}

export class RuntimeError extends Error {
  constructor(readonly code: "unsupported" | "incompatible" | "scope" | "changed" | "not-ready" | "protocol" | "transport",
    message: string, readonly submission: "not-sent" | "unknown" = "not-sent", options?: ErrorOptions) {
    super(message, options); this.name = "RuntimeError";
  }
}

export function terminalOperations(overrides: Partial<Record<RuntimeOperation, RuntimeSupport>> = {}): RuntimeDescriptor["operations"] {
  const unsupported: RuntimeSupport = { supported: false, availability: "native-unavailable", reason: "此运行接口不提供对应的结构化操作" };
  const unadapted: RuntimeSupport = { supported: false, availability: "not-adapted", reason: "原生有相关操作，尚需完成资源创建或生命周期业务适配" };
  return {
    catalog: { supported: true, semantics: "managed-resources" }, inspect: { supported: true, semantics: "observed-state" },
    read: { supported: true, semantics: "terminal-screen" }, send: { supported: true, semantics: "terminal-write" },
    interrupt: { supported: true, semantics: "interrupt-request" },
    create: unadapted, rename: unadapted, archive: unsupported, delete: unadapted, "native-steer": unsupported,
    "native-queue": unsupported, models: unsupported, settings: unsupported, goal: unsupported, usage: unsupported,
    interaction: unsupported, "structured-output": unsupported, ...overrides
  };
}

/** Reading an unready terminal is allowed, but output is discarded if its
 * observed target changes while reading. Unknown identity never grants writes. */
export function assertSameReadTarget(expected: RuntimeResource, actual: RuntimeResource): void {
  if (expected.ref.endpointId !== actual.ref.endpointId || expected.ref.id !== actual.ref.id
    || expected.incarnation !== actual.incarnation || expected.cwd !== actual.cwd || expected.machine !== actual.machine)
    throw new RuntimeError("changed", "读取期间终端目标发生变化，未返回其他程序的画面");
}

/** Observed guards narrow the race; they cannot manufacture a server CAS.
 * Callers must not persist these fingerprints as native execution ids. */
export function assertSameResource(expected: RuntimeResource, actual: RuntimeResource): void {
  if (expected.ref.endpointId !== actual.ref.endpointId || expected.ref.id !== actual.ref.id)
    throw new RuntimeError("scope", "执行目标发生变化，未发送输入");
  if (!expected.incarnation || !actual.incarnation || expected.incarnation !== actual.incarnation
    || expected.cwd !== actual.cwd || expected.machine !== actual.machine)
    throw new RuntimeError("changed", "终端程序或目录已变化，未发送输入；请重新核对目标");
}
