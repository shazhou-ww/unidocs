import {
  AdminAccessError, normalizeAdministratorEmail, requireBoundAdministrator, validateAdminIdentity,
  type AdminContext, type AdminIdentity, type BoundAdministrator,
} from "../auth/administrator.js";
import { requireAdminMcpToolAccess, type AdminMcpPolicy, type AdminMcpToolName } from "./catalog.js";

export interface VerifiedAdminMcpGrant {
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface AdminMcpMember extends BoundAdministrator {
  readonly email: string;
}

export async function resolveAdminMcpContext(options: {
  readonly verifiedGrant: VerifiedAdminMcpGrant;
  readonly toolName: AdminMcpToolName;
  readonly policy: AdminMcpPolicy;
  readonly allowedEmails: readonly string[];
  readonly now: number;
  readonly findMember: (memberId: string) => Promise<AdminMcpMember | null>;
}): Promise<AdminContext> {
  const { verifiedGrant: grant, toolName, policy, allowedEmails, findMember, now } = options;
  requireAdminMcpToolAccess(toolName, grant.scopes, policy);
  if (!grant.memberId || !grant.clientId || !Number.isSafeInteger(now) || now < 0) throw new AdminAccessError("unauthorized");
  const identity = validateAdminIdentity(grant.identity, now);
  const member = await findMember(grant.memberId);
  requireBoundAdministrator(identity, member);
  if (!member || member.memberId !== grant.memberId) throw new AdminAccessError("forbidden");
  let email: string;
  try {
    email = normalizeAdministratorEmail(member.email);
    if (!allowedEmails.map(normalizeAdministratorEmail).includes(email)) throw new Error();
  } catch {
    throw new AdminAccessError("forbidden");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grant.clientId)));
  const oauthClientHandle = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    memberId: member.memberId,
    identity: { ...identity, email },
    transport: "bearer",
    caller: { channel: "mcp", oauthClientHandle, toolName },
  };
}