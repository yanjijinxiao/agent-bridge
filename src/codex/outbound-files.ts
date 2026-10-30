/** A temporary Gateway-local copy of a file owned by the execution host. */
export type OutboundFile = { path: string; dispose(): void };
export type FetchOutboundFile = (input: {
  hostId: string; accountId: string; conversationId: string; threadId: string;
  path: string; maxBytes: number;
}) => Promise<OutboundFile>;
