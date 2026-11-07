/** Small argument reader, not a shell: no substitutions, expansion or eval.
 * Quoted paths retain spaces; -- ends Bridge flags and passes literal argv. */
export function parseRuntimeCreateCommand(value: string): { program: string; title: string; cwd?: string; args: string[] } | undefined {
  const words: string[] = []; let word = "", quote = "", started = false;
  for (const ch of value.trim()) {
    if (quote) { if (ch === quote) quote = ""; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) words.push(word); word = ""; started = false; }
    else { word += ch; started = true; }
  }
  if (quote) return;
  if (started) words.push(word);
  const fields = new Map<string, string>(); let args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const key = words[i];
    if (key === "--") { args = words.slice(i + 1); break; }
    if (!["--agent", "--name", "--cwd"].includes(key) || fields.has(key) || !words[i + 1] || words[i + 1].startsWith("--")) return;
    fields.set(key, words[++i]);
  }
  const program = fields.get("--agent"), title = fields.get("--name");
  if (!program || !title) return;
  return { program, title, cwd: fields.get("--cwd"), args };
}
export const RUNTIME_CREATE_USAGE = "新建终端：/new --agent 程序名 --name 名称 [--cwd 绝对目录] [-- 程序参数]。省略目录时使用当前项目；TUI 的名称需为小写字母开头的 1–32 位字母、数字、_ 或 -。创建会实际启动程序。";
