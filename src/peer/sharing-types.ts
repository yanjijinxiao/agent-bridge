import { z } from "zod";
import type { PeerPrincipal } from "./context.js";

export const sharingPrincipalSchema = z.object({ accountId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), actorId: z.string().min(1).max(512) }).strict();
export const sharedPermissionSchema = z.enum(["read", "chat", "stop", "approve", "manage", "files", "ide-read", "ide-write"]);
export type SharedPermission = z.infer<typeof sharedPermissionSchema>;
export const delegationSchema = z.object({ resourceId: z.string().uuid(), permissions: z.array(sharedPermissionSchema).min(1).max(8), expiresAt: z.number().int().positive().safe() }).strict();
export const peerGrantSchema = z.object({ id: z.string().uuid(), principal: sharingPrincipalSchema, hostId: z.string(), threadId: z.string().min(1).optional(), scope: z.literal("device").optional(), delegation: delegationSchema.optional() }).strict()
  .refine(g => g.scope === "device" ? g.threadId === undefined && !g.delegation : Boolean(g.threadId), "Explicit device or session scope required");
export type SharedPeerGrant = z.infer<typeof peerGrantSchema>;
export const samePerson = (a: PeerPrincipal, b: PeerPrincipal) => a.accountId === b.accountId && a.actorId === b.actorId;
export const sameChatPerson = (a: PeerPrincipal, b: PeerPrincipal) => samePerson(a, b) && a.conversationId === b.conversationId;
export type SharedTarget = { hostId: string; threadId: string };
export type SharingCommandResult = { text: string; bind?: SharedTarget };
export interface PeerSharingPort {
  command(principal: PeerPrincipal, command: "share" | "join", arg: string, target: SharedTarget | undefined, guard: () => void): Promise<SharingCommandResult>;
  admitted(principal: PeerPrincipal): boolean;
  role(principal: PeerPrincipal): "viewer" | "participant" | "controller";
  ide(principal: PeerPrincipal, target: SharedTarget, guard: () => void): Promise<string>;
  browser(principal: PeerPrincipal, code: string): Promise<string>;
}
