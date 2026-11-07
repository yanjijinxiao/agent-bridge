import { z } from "zod";
import type { RuntimeRpc } from "../json-line-client.js";
import { RuntimeError } from "../contracts.js";

export const appViewSchema = z.object({ spaces: z.array(z.object({ id: z.string(), name: z.string(), folder: z.string(), machine: z.string().nullable(),
  tabs: z.array(z.object({ id: z.string().optional(), name: z.string().optional(),
    terminals: z.array(z.object({ terminal: z.string() }).passthrough()) }).passthrough()) }).passthrough()) }).passthrough();
type WindowSpace = z.infer<typeof appViewSchema>["spaces"][number];
const docSchema = z.object({ version: z.number().int().nonnegative(), value: z.object({ spaces: z.array(z.object({ id: z.string(), name: z.string(),
  folder: z.string(), tabs: z.array(z.object({ root: z.unknown() }).passthrough()) }).passthrough()) }).nullable() }).passthrough();

/** Only explicit terminal content owns a terminal. Mod properties, shell
 * text, titles and dynamic agent-view selectors cannot establish membership. */
export function layoutTerminals(raw: unknown): string[] {
  const found = new Set<string>(); let nodes = 0;
  const content = (value: unknown) => {
    if (value && typeof value === "object" && "terminal" in value && typeof value.terminal === "string") found.add(value.terminal);
  };
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 64) throw new RuntimeError("protocol", "App 空间布局超出解析限制");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("protocol", "App 空间布局格式不兼容");
    const node = value as Record<string, unknown>;
    if (node.type === "block") content(node.content);
    else if (["row", "column", "stack"].includes(String(node.type)) && Array.isArray(node.children))
      for (const child of node.children) visit(child, depth + 1);
    else throw new RuntimeError("protocol", "App 空间布局节点不兼容");
    if (node.floating !== undefined) {
      if (!Array.isArray(node.floating)) throw new RuntimeError("protocol", "App 浮动面板格式不兼容");
      for (const item of node.floating) if (item && typeof item === "object") content(item.content);
    }
  };
  visit(raw, 0); return [...found];
}

/** The App socket does not report its core ID. Match every visible project's
 * membership against the document read from the explicitly pinned core.
 * Merely seeing t1 in both sockets is not evidence they belong together. */
export async function verifiedAppSpaces(rpc: RuntimeRpc, raw: unknown): Promise<{ spaces: WindowSpace[]; warnings: string[] }> {
  const view = appViewSchema.parse(raw);
  const machines = [...new Set(view.spaces.map(s => s.machine))];
  if (machines.length > 100) throw new RuntimeError("protocol", "App 空间涉及过多机器");
  const docs = await Promise.allSettled(machines.map(async machine => {
    const doc = docSchema.parse(await rpc.request("doc.get", { name: "herdr-app", on: machine }));
    return (doc.value?.spaces ?? []).map(s => ({ id: machine ? `${machine}/${s.id}` : s.id,
      folder: s.folder, terminals: [...new Set(s.tabs.flatMap(tab => layoutTerminals(tab.root)))].map(id => machine ? `${machine}/${id}` : id) }));
  }));
  const spaces: WindowSpace[] = [], warnings: string[] = [];
  for (const space of view.spaces) {
    const result = docs[machines.indexOf(space.machine)];
    const matches = result.status === "fulfilled" ? result.value.filter(s => s.id === space.id) : [];
    const terminals = [...new Set(space.tabs.flatMap(tab => tab.terminals.map(t => t.terminal)))].sort();
    if (matches.length !== 1 || matches[0].folder !== space.folder
      || JSON.stringify([...matches[0].terminals].sort()) !== JSON.stringify(terminals)) {
      // Keep the name in the directory, but neither roots nor resource edges
      // from an unverified window can grant filesystem/IDE membership.
      spaces.push({ ...space, folder: "", tabs: [] });
      warnings.push(`空间 ${space.name} 与所选执行核心的布局未核对一致，目录和归属未授权`);
    } else spaces.push(space);
  }
  return { spaces, warnings };
}
