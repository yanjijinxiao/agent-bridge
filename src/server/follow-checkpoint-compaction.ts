import type { ChannelStreamCheckpoint } from "../channels/progress.js";

/** A carried stage summary belongs to the current presentation. Old final
 * results must retain their own payload/receipts, but need not duplicate an
 * identical stage record already kept by that presentation. No IDs alone are
 * sufficient: differing retry state, text or acknowledgements remain intact.
 * This keeps the existing on-disk schema and never drops an undelivered result.
 */
export function compactArchivedSummaries(state: {
  checkpoint?: ChannelStreamCheckpoint;
  pendingTerminals?: Record<string, { checkpoint?: ChannelStreamCheckpoint }>;
}): number {
  const retained = new Set(state.checkpoint?.segments?.previous.map(item => JSON.stringify(item)) ?? []);
  if (!retained.size) return 0;
  let removed = 0;
  for (const pending of Object.values(state.pendingTerminals ?? {})) {
    const saved = pending.checkpoint, segments = saved?.segments;
    if (!saved || !segments?.previous.length) continue;
    const previous = segments.previous.filter(item => !retained.has(JSON.stringify(item)));
    if (previous.length === segments.previous.length) continue;
    removed += segments.previous.length - previous.length;
    // archiveTerminal can share the current checkpoint object. Never mutate it
    // in place: that would also erase the sole retained copy of the stages.
    pending.checkpoint = { ...saved, segments: { ...segments, previous } };
  }
  return removed;
}
