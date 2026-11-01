import type { CodexApprovalDecision, CodexApprovalRequest, CodexApprovalResult, AppServerApprovalMethod } from "./approval.js";
import type { CodexUserInputRequest, CodexUserInputAnswer, CodexUserInputResult } from "./backend.js";
import type { McpForm } from "./elicitation.js";
import type { NativeAsyncAnswerReceipt } from "./async-user-input.js";

export type NativeApproval = { hostId?: string; requestId: string | number; method: AppServerApprovalMethod; request: CodexApprovalRequest };
export type NativeUserInput = { hostId: string; requestId: string | number; method: "item/tool/requestUserInput";
  request: CodexUserInputRequest; mcpForm?: McpForm };
export type NativeUnsupportedInteraction = { hostId: string; threadId: string; turnId: string; requestId: string | number;
  method: string; reason?: "authentication" | "schema-unsupported" | "request-unsupported"; safeUrl?: string };
export type NativeInteractionObserver = {
  onProgress?(scope: { hostId: string; threadId: string; turnId: string }, text: string): Promise<void> | void;
  onApproval(input: NativeApproval): Promise<CodexApprovalDecision | undefined>;
  onResult?(input: NativeApproval, result: CodexApprovalResult): void | Promise<void>;
  onUserInput?(input: NativeUserInput): Promise<CodexUserInputAnswer | undefined>;
  onUserInputResult?(input: NativeUserInput, result: CodexUserInputResult): void | Promise<void>;
  onObservedUserInputAnswers?(receipts: NativeAsyncAnswerReceipt[]): Promise<void> | void;
  onUnsupportedInteraction?(input: NativeUnsupportedInteraction): Promise<boolean | void>;
};
export type NativeInteractionTarget = { hostId: string; threadId: string };
