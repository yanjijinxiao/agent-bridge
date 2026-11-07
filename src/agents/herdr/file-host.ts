import crypto from "node:crypto";
import { z } from "zod";
import type { ScriptHost } from "../../hosts/script-host.js";
import { RuntimeError } from "../contracts.js";
import type { RuntimeRpc } from "../json-line-client.js";

// The public machine profile is the core's connection configuration. This
// adapter never derives an SSH target from an address, cwd, or Codex settings.
const machineSchema = z.object({ name: z.string().min(1), id: z.string().min(1), target: z.string().min(1).max(8192),
  via: z.boolean(), session: z.string().nullable(), state: z.string() }).passthrough();
export async function herdrFileHost(rpc: RuntimeRpc, endpointId: string, machine: string,
  scope: string, current: () => Promise<void>): Promise<ScriptHost> {
  const read = async () => {
    await current();
    const result = z.object({ machines: z.array(machineSchema) }).passthrough().parse(await rpc.request("machine.list", {}));
    const candidates = result.machines.filter(m => m.name === machine);
    if (candidates.length !== 1 || candidates[0].state !== "connected") throw new RuntimeError("not-ready", "Herdr 资源所属机器尚未连接");
    const { name, id, target, via, session } = candidates[0];
    if (/[\0\r\n]/.test(target) || !via && target.startsWith("-")) throw new RuntimeError("scope", "Herdr 机器连接配置无效");
    return { name, id, target, via, session };
  };
  const profile = await read(), stamp = JSON.stringify(profile);
  const verify = async () => {
      if (JSON.stringify(await read()) !== stamp) throw new RuntimeError("changed", "Herdr 机器身份或连接配置已改变");
      await current();
  };
  return { id: "runtime-host:" + crypto.createHash("sha256").update(JSON.stringify([endpointId, profile, scope])).digest("hex"),
    verify,
    async command(script, argument) {
      await verify();
      // Containerized Node launchers can reset HOME to /. Carry the selected
      // login shell's home as an argv value and restore it only in this helper,
      // just as the existing native SSH file transport does. IDE and file
      // helpers must agree on the account's persistent data location.
      const prelude = "process.env.HOME=process.argv.splice(1,1)[0];"
        + (argument === undefined ? "" : "process.argv[1]=Buffer.from(process.argv[1],'base64').toString();");
      const code = Buffer.from(prelude + script).toString("base64");
      // Both values below are application-generated base64, not shell syntax.
      const line = `exec node -e "eval(Buffer.from('${code}','base64').toString())" -- "$HOME"${argument === undefined ? "" : ` '${Buffer.from(argument).toString("base64")}'`}`;
      // Preserve the helper's expected argv: the outer base64 layer prevents
      // even a future non-base64 caller from introducing shell interpolation.
      if (profile.via) return { command: "sh", args: ["-c", `${profile.target} "$1"`, "sh", line] };
      return { command: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", profile.target, line] };
    } };
}
