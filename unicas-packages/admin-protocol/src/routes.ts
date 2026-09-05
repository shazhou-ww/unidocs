export type CasAdminRoute =
  | { operation: "me" }
  | { operation: "listStacks" }
  | { operation: "createStack" }
  | { operation: "getStack"; stackId: string }
  | { operation: "patchStack"; stackId: string }
  | { operation: "listMembers"; stackId: string }
  | { operation: "deleteMember"; stackId: string }
  | { operation: "createMemberInvitation"; stackId: string }
  | { operation: "acceptMemberInvitation"; token: string }
  | { operation: "getOAuthIssuer"; stackId: string }
  | { operation: "inspectOAuthIssuer"; stackId: string }
  | { operation: "activateOAuthIssuer"; stackId: string }
  | { operation: "listRefDomains"; stackId: string }
  | { operation: "listControlAuditEvents"; stackId: string }
  | { operation: "listRootDomainRefs"; stackId: string; refDomain: string }
  | { operation: "listRootDomainEvents"; stackId: string; refDomain: string };

function segment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export const casAdminRoutes = {
  me: () => "/admin/me",
  stacks: () => "/admin/stacks",
  stack: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}`,
  members: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/members`,
  memberInvitations: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/member-invitations`,
  acceptMemberInvitation: ({ token }: { token: string }) =>
    `/admin/member-invitations/${segment(token)}/accept`,
  oauthIssuer: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/oauth-issuer`,
  oauthIssuerInspections: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/oauth-issuer/inspections`,
  refDomains: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/ref-domains`,
  controlAuditEvents: ({ stackId }: { stackId: string }) =>
    `/admin/stacks/${segment(stackId)}/audit-events`,
  rootDomainRefs: ({ stackId, refDomain }: { stackId: string; refDomain: string }) =>
    `/admin/stacks/${segment(stackId)}/root-ref-domains/${segment(refDomain)}/refs`,
  rootDomainEvents: ({ stackId, refDomain }: { stackId: string; refDomain: string }) =>
    `/admin/stacks/${segment(stackId)}/root-ref-domains/${segment(refDomain)}/events`,
} as const;

/**
 * Matches only `/admin/...` control-plane resources.
 * Never returns a tenant data-plane operation.
 */
export function matchCasAdminRoute(
  method: string,
  pathname: string,
): CasAdminRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "admin") return null;

  if (parts.length === 2 && parts[1] === "me" && method === "GET") {
    return { operation: "me" };
  }

  if (parts.length === 2 && parts[1] === "stacks") {
    if (method === "GET") return { operation: "listStacks" };
    if (method === "POST") return { operation: "createStack" };
    return null;
  }

  if (
    parts.length === 4
    && parts[1] === "member-invitations"
    && parts[3] === "accept"
    && method === "POST"
  ) {
    const token = decodeSegment(parts[2]!);
    return token === null ? null : { operation: "acceptMemberInvitation", token };
  }

  if (parts[1] !== "stacks" || !parts[2]) return null;
  const stackId = decodeSegment(parts[2]);
  if (stackId === null) return null;

  if (parts.length === 3) {
    if (method === "GET") return { operation: "getStack", stackId };
    if (method === "PATCH") return { operation: "patchStack", stackId };
    return null;
  }

  if (parts.length === 4 && parts[3] === "members") {
    if (method === "GET") return { operation: "listMembers", stackId };
    if (method === "DELETE") return { operation: "deleteMember", stackId };
    return null;
  }

  if (parts.length === 4 && parts[3] === "member-invitations" && method === "POST") {
    return { operation: "createMemberInvitation", stackId };
  }

  if (parts.length === 4 && parts[3] === "oauth-issuer") {
    if (method === "GET") return { operation: "getOAuthIssuer", stackId };
    if (method === "PUT") return { operation: "activateOAuthIssuer", stackId };
    return null;
  }

  if (
    parts.length === 5
    && parts[3] === "oauth-issuer"
    && parts[4] === "inspections"
    && method === "POST"
  ) {
    return { operation: "inspectOAuthIssuer", stackId };
  }

  if (parts.length === 4 && parts[3] === "ref-domains") {
    return method === "GET" ? { operation: "listRefDomains", stackId } : null;
  }

  if (parts.length === 4 && parts[3] === "audit-events" && method === "GET") {
    return { operation: "listControlAuditEvents", stackId };
  }

  if (
    parts.length === 6
    && parts[3] === "root-ref-domains"
    && parts[4]
    && (parts[5] === "refs" || parts[5] === "events")
    && method === "GET"
  ) {
    const refDomain = decodeSegment(parts[4]);
    if (refDomain === null) return null;
    if (parts[5] === "refs") {
      return { operation: "listRootDomainRefs", stackId, refDomain };
    }
    return { operation: "listRootDomainEvents", stackId, refDomain };
  }

  return null;
}
