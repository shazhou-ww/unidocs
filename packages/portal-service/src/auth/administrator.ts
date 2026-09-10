import { AddAdministratorMemberRequestSchema } from "@unidocs/protocol-admin-portal";

export class AdminAccessError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden") {
    super(code === "unauthorized" ? "Administrator authentication is required" : "Administrator access is denied");
    this.name = "AdminAccessError";
  }
}

export interface AdminIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly authenticatedAt: number;
}

export interface AdminContext {
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly transport: "bearer" | "session";
}

export interface BoundAdministrator {
  readonly memberId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly active: boolean;
}

export function normalizeAdministratorEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return AddAdministratorMemberRequestSchema.parse({ email: normalized }).email;
}

export function googleIdentityFromVerifiedClaims(claims: Readonly<Record<string, unknown>>, now: number): AdminIdentity {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new AdminAccessError("unauthorized");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || /[^\x21-\x7e]/.test(claims.sub)) throw new AdminAccessError("unauthorized");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new AdminAccessError("unauthorized");
  if (!Number.isSafeInteger(claims.auth_time) || typeof claims.auth_time !== "number" || claims.auth_time < 0 || !Number.isFinite(now) || claims.auth_time > now + 30) throw new AdminAccessError("unauthorized");
  let email: string;
  try {
    email = normalizeAdministratorEmail(claims.email);
  } catch {
    throw new AdminAccessError("unauthorized");
  }
  return { issuer: "https://accounts.google.com", subject: claims.sub, email, authenticatedAt: claims.auth_time };
}

export function requireBoundAdministrator(identity: AdminIdentity, member: BoundAdministrator | null): BoundAdministrator {
  if (!member?.active || member.issuer !== identity.issuer || member.subject !== identity.subject) throw new AdminAccessError("forbidden");
  return member;
}

export function requireRecentAuthentication(identity: AdminIdentity, now: number): void {
  if (!Number.isSafeInteger(identity.authenticatedAt) || identity.authenticatedAt < 0 || !Number.isSafeInteger(now) || now < 0 || identity.authenticatedAt > now + 30 || now - identity.authenticatedAt > 300) {
    throw new AdminAccessError("forbidden");
  }
}

export function requireBootstrapIdentity(identity: AdminIdentity, configuredEmail: string | null, now: number): void {
  requireRecentAuthentication(identity, now);
  if (configuredEmail === null || identity.issuer !== "https://accounts.google.com" || identity.email !== normalizeAdministratorEmail(configuredEmail)) throw new AdminAccessError("forbidden");
}