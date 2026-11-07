/** Deployment-owned process transport. Scripts are fixed application helpers;
 * untrusted paths/content travel as data, never interpolated shell programs. */
export type HostInvocation = { command: string; args: string[] };
export type ScriptHost = {
  /** Includes the verified machine, reach configuration and resource/file scope. */
  id: string;
  /** Read-only revalidation, including after an asynchronous file transfer. */
  verify(): Promise<void>;
  command(script: string, argument?: string): Promise<HostInvocation>;
};
export type HostCommandResolver = (hostId: string, script: string, input: object) => Promise<HostInvocation>;
export function scriptHostResolver(host: ScriptHost): HostCommandResolver {
  return (id, script, input) => {
    if (id !== host.id) throw Error("Filesystem host changed");
    return host.command(script, Buffer.from(JSON.stringify(input)).toString("base64"));
  };
}
