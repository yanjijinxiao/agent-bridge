import { createTaskboardNativeBackend } from "../server/native-backend.mjs";

/** Quota reads attach to the same selected native core as all other clients. */
export async function readCodexQuotaStatus(model, suppliedBackend) {
  const checkedAt = Date.now();
  const backend = suppliedBackend ?? createTaskboardNativeBackend();
  try {
    const balance = await backend.getAccountRateLimits(undefined, model);
    return evaluateRateLimits({ rateLimits: balance }, model, checkedAt);
  } catch {
    return { state: "unknown", checkedAt };
  } finally {
    if (!suppliedBackend) await backend.close().catch(() => {});
  }
}

function evaluateRateLimits(result, model, checkedAt) {
  const snapshots = result?.rateLimitsByLimitId;
  const entries = snapshots && typeof snapshots === "object" && !Array.isArray(snapshots)
    ? Object.entries(snapshots).filter(([, snapshot]) => (
    snapshot && typeof snapshot === "object"
    ))
    : [];
  const normalizedModel = normalizeName(model);
  const snapshot = entries.find(([, value]) => (
    normalizeName(value.limitName) === normalizedModel
  ))?.[1]
    ?? entries.find(([limitId]) => limitId === "codex")?.[1]
    ?? (
      result?.rateLimits
      && typeof result.rateLimits === "object"
      && !Array.isArray(result.rateLimits)
        ? result.rateLimits
        : null
    );
  if (!snapshot) return { state: "unknown", checkedAt };

  const windows = [snapshot.primary, snapshot.secondary]
    .filter(window => Number.isFinite(window?.usedPercent));
  const creditsAvailable = snapshot.credits?.unlimited === true
    || snapshot.credits?.hasCredits === true;
  const exhaustedWindows = windows.filter((window) => (
    window.usedPercent >= 100
  ));
  const individualRemaining = snapshot.individualLimit?.remainingPercent;
  const hasIndividualLimit = Number.isFinite(individualRemaining);
  const individuallyExhausted = hasIndividualLimit && individualRemaining <= 0;
  const blocked = Boolean(snapshot.rateLimitReachedType)
    || snapshot.spendControlReached === true
    || individuallyExhausted
    || (exhaustedWindows.length > 0 && !creditsAvailable);

  // The native adapter may return plan metadata without usable quota fields.
  // Missing evidence must not authorize a quota-aware automation to start.
  if (!blocked) return {
    state: windows.length || hasIndividualLimit || creditsAvailable ? "available" : "unknown",
    checkedAt,
  };

  const resetCandidates = [
    ...exhaustedWindows.map((window) => window.resetsAt),
    snapshot.individualLimit?.resetsAt,
  ];
  if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) {
    resetCandidates.push(...windows.map((window) => window.resetsAt));
  }
  const resetsAt = Math.max(...resetCandidates.filter(Number.isFinite));
  return {
    state: "blocked",
    checkedAt,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

function normalizeName(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}
