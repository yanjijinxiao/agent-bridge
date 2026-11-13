import { commandHelpChoices } from "./command-help.js";
import {
  createChoiceCard,
  type ChannelActionCard,
  type ChannelActionCommand,
  type ChannelChoice,
  type ChannelCardTemplate
} from "../channels/action-card.js";

type CommandChoice = {
  readonly label: string;
  readonly arg: string;
  readonly active?: boolean;
};

type CommandSelectionCardInput = {
  readonly title: string;
  readonly body: string;
  readonly command: ChannelActionCommand;
  readonly choices: readonly CommandChoice[];
  readonly fallbackText: string;
  readonly note?: string;
  readonly template?: ChannelCardTemplate;
  readonly includeDefault?: boolean;
};

/** Buttons use the same backend/configuration selection as the help body. */
export function createMainMenuCard(fallbackText: string, choices: readonly ChannelChoice[] = commandHelpChoices()): ChannelActionCard {
  return createChoiceCard({ title: "Agent Bridge · 帮助", body: fallbackText, fallbackText, choices });
}

export function createCommandSelectionCard(input: CommandSelectionCardInput): ChannelActionCard {
  const choices: ChannelChoice[] = input.choices.map((choice) => ({
    label: choice.label,
    command: input.command,
    arg: choice.arg,
    style: choice.active ? "primary" : "default"
  }));
  if (input.includeDefault) {
    choices.push({ label: "恢复默认", command: input.command, arg: "default", style: "default" });
  }
  return createChoiceCard({
    title: input.title,
    body: input.body,
    fallbackText: input.fallbackText,
    choices,
    ...(input.note ? { note: input.note } : {}),
    ...(input.template ? { template: input.template } : {})
  });
}

export function conciseButtonLabel(label: string, maximumLength = 20): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 1)}…`
    : normalized;
}
