/** The Taskboard is another client of the Gateway's one protocol adapter.
 * Deployment chooses the endpoint; catalog/execution never spawn CLI helpers.
 * Standalone distributions must include the root build beside this package. */
export function createTaskboardNativeBackend(options = {}) {
  let backend = options.nativeBackend;
  let pending;
  let closed = false;
  const get = async () => {
    if (closed) throw new Error("Taskboard native connection is closed");
    if (backend) return backend;
    pending ??= (async () => {
      if (options.nativeBackendFactory) return options.nativeBackendFactory();
      const { CodexAppServerGateway } = await import("../../dist/codex/app-server-gateway.js");
      return new CodexAppServerGateway({
        codexBin: options.codexExecutable,
        codexHome: options.codexHome,
        appServerTransport: options.appServerTransport ?? "daemon",
      });
    })();
    backend = await pending;
    if (closed) throw new Error("Taskboard native connection is closed");
    return backend;
  };
  const methods = ["run", "runQueuedSubmission", "inspectThread", "readTurnLifecycle", "readTurnActivities", "interruptTurn",
    "listModels", "listSkills", "listMcpServers", "getAccountRateLimits", "observeThreadInteractions", "unobserveThreadInteractions"];
  const client = Object.fromEntries(methods.map(method => [method, async (...args) => {
    const selected = await get();
    if (typeof selected[method] !== "function") throw new Error(`Native App Server adapter does not support ${method}`);
    return selected[method](...args);
  }]));
  return Object.assign(client, {
    hasRestartBlockingWork() { return Boolean(backend?.hasRestartBlockingWork?.()); },
    async close() {
      closed = true;
      const selected = backend ?? await pending?.catch(() => undefined);
      await selected?.close();
    },
  });
}
