import type { NativeInteractionObserver, NativeApproval, NativeUserInput } from "./interactions.js";
import type { CodexApprovalDecision } from "./approval.js";
import type { CodexUserInputAnswer, CodexUserInputResult } from "./backend.js";

type Envelope = NativeApproval | NativeUserInput;
type Answer = CodexApprovalDecision | CodexUserInputAnswer | undefined;
type Offer = { observer: NativeInteractionObserver; pending: boolean };
type Pending = { kind: "approval" | "input"; envelope: Envelope; offers: Map<string, Offer>;
  decided: boolean; winner?: Offer; resolve(answer: Answer): void; promise: Promise<Answer> };

/** Multiple surfaces observe one native subscription. The first still-current
 * explicit answer wins; neither missing consumers nor failures imply refusal. */
export class NativeInteractionFanout {
  private readonly consumers = new Map<string, NativeInteractionObserver>();
  private readonly requests = new Map<string, Pending>();
  readonly observer: NativeInteractionObserver = {
    onApproval: input => this.request("approval", input) as Promise<CodexApprovalDecision | undefined>,
    onUserInput: input => this.request("input", input) as Promise<CodexUserInputAnswer | undefined>,
    onResult: (input, result) => this.finish("approval", input, result,
      (observer, selected) => observer.onResult?.(input, selected === "suspended" ? "withdrawn" : selected)),
    onUserInputResult: (input, result) => this.finish("input", input, result,
      (observer, selected) => observer.onUserInputResult?.(input, selected)),
    onProgress: (scope, text) => this.notify(observer => observer.onProgress?.(scope, text)),
    onObservedUserInputAnswers: receipts => this.notify(observer => observer.onObservedUserInputAnswers?.(receipts)),
    onUnsupportedInteraction: input => this.notify(observer => observer.onUnsupportedInteraction?.(input)),
  };

  get empty(): boolean { return this.consumers.size === 0; }
  has(id: string): boolean { return this.consumers.has(id); }

  add(id: string, observer: NativeInteractionObserver): void {
    if (this.consumers.get(id) === observer) return;
    this.consumers.set(id, observer);
    for (const pending of this.requests.values()) {
      const previous = pending.offers.get(id);
      if (previous) previous.pending = false;
      // Replacing a consumer after its answer was selected must also retire
      // its offer identity; the new observer cannot inherit a late receipt.
      pending.offers.delete(id);
      this.offer(pending, id, observer);
    }
  }

  remove(id: string): void {
    this.consumers.delete(id);
    for (const pending of this.requests.values()) {
      const offer = pending.offers.get(id);
      if (offer) offer.pending = false;
      pending.offers.delete(id);
      this.retireUnanswered(pending);
    }
  }

  close(): void {
    this.consumers.clear();
    for (const pending of this.requests.values()) { pending.decided = true; pending.resolve(undefined); }
    this.requests.clear();
  }

  private key(kind: string, envelope: Envelope): string {
    return JSON.stringify([kind, envelope.request.threadId, envelope.request.turnId, typeof envelope.requestId, envelope.requestId]);
  }

  private request(kind: Pending["kind"], envelope: Envelope): Promise<Answer> {
    const key = this.key(kind, envelope), existing = this.requests.get(key);
    if (existing) return existing.promise;
    let resolve!: (answer: Answer) => void;
    const promise = new Promise<Answer>(complete => { resolve = complete; });
    const pending: Pending = { kind, envelope, offers: new Map(), decided: false, resolve, promise };
    this.requests.set(key, pending);
    for (const [id, observer] of this.consumers) this.offer(pending, id, observer);
    this.retireUnanswered(pending);
    return pending.promise;
  }

  private offer(pending: Pending, id: string, observer: NativeInteractionObserver): void {
    if (pending.decided) return;
    const offer: Offer = { observer, pending: true }; pending.offers.set(id, offer);
    void Promise.resolve().then(async (): Promise<Answer> => {
      if (this.consumers.get(id) !== observer || !offer.pending) return;
      return pending.kind === "approval" ? observer.onApproval(pending.envelope as NativeApproval)
        : observer.onUserInput?.(pending.envelope as NativeUserInput);
    }).then(answer => {
      if (answer === undefined || pending.decided || !offer.pending || this.consumers.get(id) !== observer) return;
      pending.winner = offer; pending.decided = true; pending.resolve(answer);
    }, () => {}).finally(() => { offer.pending = false; this.retireUnanswered(pending); });
  }

  private retireUnanswered(pending: Pending): void {
    if (pending.decided || [...pending.offers.values()].some(offer => offer.pending)) return;
    pending.decided = true; pending.resolve(undefined);
    const key = this.key(pending.kind, pending.envelope);
    if (this.requests.get(key) === pending) this.requests.delete(key);
  }

  private async finish(kind: Pending["kind"], envelope: Envelope, result: CodexUserInputResult,
    notify: (observer: NativeInteractionObserver, result: CodexUserInputResult) => unknown): Promise<void> {
    const key = this.key(kind, envelope), pending = this.requests.get(key);
    // A lost receipt is not permission to answer again. Keep the chosen
    // consumer for a later native confirmation of this exact request.
    if (result !== "failed") this.requests.delete(key);
    if (pending && !pending.decided) { pending.decided = true; pending.resolve(undefined); }
    await this.notify((observer, id) => notify(observer,
      (result === "confirmed" || result === "failed")
        && (!pending?.winner || pending.offers.get(id) !== pending.winner) ? "withdrawn" : result));
  }

  private async notify(callback: (observer: NativeInteractionObserver, id: string) => unknown): Promise<void> {
    await Promise.allSettled([...this.consumers.entries()].map(async ([id, observer]) => {
      if (this.consumers.get(id) === observer) await callback(observer, id);
    }));
  }
}
