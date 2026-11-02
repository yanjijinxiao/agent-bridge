/** System-generated user-role envelopes are not human conversation previews.
 * Match only complete, known wrappers or the specific approval transcript
 * preamble; ordinary user text quoting these tags remains public. */
export function isInternalUserMessage(value: string): boolean {
  const text = value.trimStart();
  if (text.startsWith("<environment_context>") && text.trimEnd().endsWith("</environment_context>")) return true;
  if (text.startsWith("<recommended_plugins>") && (text.trimEnd().endsWith("</recommended_plugins>")
    || text.trimEnd().endsWith("</environment_context>"))) return true;
  if (text.startsWith("<turn_aborted>") && text.trimEnd().endsWith("</turn_aborted>")) return true;
  if (!text.startsWith("The following is the Codex agent history")) return false;
  return text.includes("whose request action you are assessing") || text.includes("added since your last approval assessment")
    || text.includes(">>> APPROVAL REQUEST START") && (text.includes(">>> TRANSCRIPT START") || text.includes(">>> TRANSCRIPT DELTA START"));
}
