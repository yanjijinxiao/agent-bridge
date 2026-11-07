/** Connector-owned resources only. Failure to close an IDE lease or transport
 * cannot leave the remaining observers or single-owner state lock behind.
 * No callback here should interrupt the independently running agent. */
export async function closeConnectorResources(actions: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try { await action(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Connector resource cleanup failed; all owned resources were attempted");
}
