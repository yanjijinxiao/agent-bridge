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

  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  const creditsAvailable = snapshot.credits?.unlimited === true
    || snapshot.credits?.hasCredits === true;
  const exhaustedWindows = windows.filter((window) => (
    Number(window.usedPercent) >= 100
  ));
  const individuallyExhausted = Number(snapshot.individualLimit?.remainingPercent) <= 0;
  const blocked = Boolean(snapshot.rateLimitReachedType)
    || snapshot.spendControlReached === true
    || individuallyExhausted
    || (exhaustedWindows.length > 0 && !creditsAvailable);

  if (!blocked) return { state: "available", checkedAt };

  const resetCandidates = [
    ...exhaustedWindows.map((window) => Number(window.resetsAt)),
    Number(snapshot.individualLimit?.resetsAt),
  ];
  if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) {
    resetCandidates.push(...windows.map((window) => Number(window.resetsAt)));
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
