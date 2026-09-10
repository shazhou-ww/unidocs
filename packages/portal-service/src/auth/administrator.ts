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
  readonly authenticatedAt: number | null;
  readonly loginConfirmedAt?: number;
  readonly loginConfirmation?: "authorization-code-v1";
}

export interface AdminContext {
  readonly memberId: string;
  readonly identity: AdminIdentity;
  readonly transport: "bearer" | "session";
  readonly sessionHash?: string;
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
  return readGoogleIdentity(claims, now, false);
}

export function googleIdentityFromConfirmedLogin(claims: Readonly<Record<string, unknown>>, confirmedAt: number): AdminIdentity {
  if (!Number.isSafeInteger(confirmedAt) || confirmedAt < 0) throw new AdminAccessError("unauthorized");
  return { ...readGoogleIdentity(claims, confirmedAt, true), loginConfirmedAt: confirmedAt, loginConfirmation: "authorization-code-v1" };
}

function readGoogleIdentity(claims: Readonly<Record<string, unknown>>, now: number, allowMissingAuthTime: boolean): AdminIdentity {
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new AdminAccessError("unauthorized");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || /[^\x21-\x7e]/.test(claims.sub)) throw new AdminAccessError("unauthorized");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new AdminAccessError("unauthorized");
  let authenticatedAt: number | null = null;
  if (claims.auth_time !== undefined || !allowMissingAuthTime) {
    if (!Number.isSafeInteger(claims.auth_time) || typeof claims.auth_time !== "number" || claims.auth_time < 0 || !Number.isFinite(now) || claims.auth_time > now + 30) throw new AdminAccessError("unauthorized");
    authenticatedAt = claims.auth_time;
  }
  let email: string;
  try {
    email = normalizeAdministratorEmail(claims.email);
  } catch {
    throw new AdminAccessError("unauthorized");
  }
  return { issuer: "https://accounts.google.com", subject: claims.sub, email, authenticatedAt };
}

export function validateAdminIdentity(identity: AdminIdentity, now: number): AdminIdentity {
  const confirmed = identity.loginConfirmation === "authorization-code-v1";
  if ((identity.loginConfirmation !== undefined || identity.loginConfirmedAt !== undefined) && !confirmed) throw new AdminAccessError("unauthorized");
  const verified = readGoogleIdentity({ iss: identity.issuer, sub: identity.subject, email: identity.email, email_verified: true,
    auth_time: identity.authenticatedAt === null ? undefined : identity.authenticatedAt }, now, confirmed);
  if (!confirmed) return verified;
  if (typeof identity.loginConfirmedAt !== "number" || !Number.isSafeInteger(identity.loginConfirmedAt) || identity.loginConfirmedAt < 0 || identity.loginConfirmedAt > now) throw new AdminAccessError("unauthorized");
  return { ...verified, loginConfirmedAt: identity.loginConfirmedAt, loginConfirmation: "authorization-code-v1" };
}

export function adminConfirmationTime(identity: AdminIdentity): number | null {
  if (identity.loginConfirmation === "authorization-code-v1") return identity.loginConfirmedAt ?? null;
  if (identity.loginConfirmation !== undefined || identity.loginConfirmedAt !== undefined) return null;
  return identity.authenticatedAt;
}

export function requireBoundAdministrator(identity: AdminIdentity, member: BoundAdministrator | null): BoundAdministrator {
  if (!member?.active || member.issuer !== identity.issuer || member.subject !== identity.subject) throw new AdminAccessError("forbidden");
  return member;
}

export function requireRecentAuthentication(identity: AdminIdentity, now: number): void {
  const confirmedAt = adminConfirmationTime(identity);
  const skew = identity.loginConfirmation === "authorization-code-v1" ? 0 : 30;
  if (confirmedAt === null || !Number.isSafeInteger(confirmedAt) || confirmedAt < 0 || !Number.isSafeInteger(now) || now < 0 || confirmedAt > now + skew || now - confirmedAt > 300) {
    throw new AdminAccessError("forbidden");
  }
}

export function requireBootstrapIdentity(identity: AdminIdentity, configuredEmail: string | null, now: number): void {
  requireRecentAuthentication(identity, now);
  if (configuredEmail === null || identity.issuer !== "https://accounts.google.com" || identity.email !== normalizeAdministratorEmail(configuredEmail)) throw new AdminAccessError("forbidden");
}