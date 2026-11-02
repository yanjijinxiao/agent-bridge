// Historical scheduler formats only. Live execution/UI query model/list.
export const AUTOMATION_MODELS = [
  {
    label: "5.6 Sol",
    slug: "gpt-5.6-sol",
    defaultEffort: "low",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    label: "5.6 Terra",
    slug: "gpt-5.6-terra",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    label: "5.6 Luna",
    slug: "gpt-5.6-luna",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    label: "5.5",
    slug: "gpt-5.5",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    label: "5.4",
    slug: "gpt-5.4",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh"],
  },
  {
    label: "5.4 Mini",
    slug: "gpt-5.4-mini",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "xhigh"],
  },
];

const MODELS_BY_SLUG = new Map(AUTOMATION_MODELS.map((model) => [model.slug, model]));

export function getAutomationModel(value) {
  return MODELS_BY_SLUG.get(value);
}

export function isAutomationModel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\r\n\0]/.test(value);
}

export function isAutomationReasoningEffort(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

/** Persistence validates shape. Availability belongs to the selected native
 * catalog at the UI and final submission boundary, not a bundled model list. */
export function isAutomationSelection(model, effort) {
  return isAutomationModel(model) && isAutomationReasoningEffort(effort);
}

export function isSupportedModelEffort(model, effort) {
  return getAutomationModel(model)?.efforts.includes(effort) ?? false;
}

export function withAutomationModel(options, model) {
  const nextModel = getAutomationModel(model);
  if (!nextModel) throw new Error("Model is not part of the historical scheduler catalog");
  return {
    ...options,
    model,
    reasoningEffort: nextModel.efforts.includes(options.reasoningEffort)
      ? options.reasoningEffort
      : nextModel.defaultEffort,
  };
}
