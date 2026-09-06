/**
 * Control-plane input validation. All validators return `null` for valid
 * input and a human-readable message for invalid input. Rejecting values must
 * never depend on caller-supplied structure beyond these checks.
 */

export const CONTROL_LIST_DEFAULT_LIMIT = 50;
export const CONTROL_LIST_MAX_LIMIT = 200;
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export const STACK_ID_PATTERN = /^cas_[A-Za-z0-9_-]{8,64}$/;
/** Reserved domain used only for imported migration audit baselines. */
export const LEGACY_DOMAIN = "_legacy";
export const SUPPORTED_KEY_ALGORITHMS = ["ES256", "RS256", "EdDSA"] as const;
export type SupportedKeyAlgorithm = (typeof SUPPORTED_KEY_ALGORITHMS)[number];

export function isSupportedKeyAlgorithm(value: string): value is SupportedKeyAlgorithm {
  return (SUPPORTED_KEY_ALGORITHMS as readonly string[]).includes(value);
}

export function validateDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return "displayName must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "displayName must not be empty";
  if (trimmed.length > 120) return "displayName must be at most 120 characters";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "displayName contains control characters";
  return null;
}

/** Fixed cap for discovered Stack OAuth issuers; not administrator configurable. */
export const OAUTH_CAPABILITY_MAX_LIFETIME_SECONDS = 30 * 60;

/** Canonical OAuth resource/audience owned by this UniCAS deployment. */
export function stackOAuthResource(publicOrigin: string, stackId: string): string {
  let url: URL;
  try {
    url = new URL(publicOrigin);
  } catch {
    throw new TypeError("OAuth resource public origin must be an absolute URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username || url.password || !url.hostname) {
    throw new TypeError("OAuth resource public origin must be HTTP(S) without credentials");
  }
  return `${url.origin}/stacks/${encodeURIComponent(stackId)}`;
}

/** Email is display metadata; used only for invitation display constraints. */
export function validateEmailConstraint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "emailConstraint must be a string";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "emailConstraint must not be empty";
  if (trimmed.length > 254) return "emailConstraint is too long";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "emailConstraint must be a valid email address";
  }
  return null;
}

/**
 * Normalize an email constraint for storage/display comparison.
 * Returns null when absent; callers must validate first.
 */
export function normalizeEmailConstraint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value).trim().toLowerCase();
}

export function validateInvitationToken(value: unknown): string | null {
  if (typeof value !== "string") return "invitation token must be a string";
  if (value.length < 32 || value.length > 128) {
    return "invitation token has an invalid length";
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return "invitation token is malformed";
  return null;
}

/** Parse a list limit into [default, max]; null when out of range. */
export function parseControlListLimit(
  value: number | undefined,
): number | null {
  if (value === undefined) return CONTROL_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > CONTROL_LIST_MAX_LIMIT) {
    return null;
  }
  return value;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable, non-PII owner key shared by managed capabilities and Playground state. */
export function managedPlaygroundOwnerKey(
  stackId: string,
  identity: { readonly identityIssuer: string; readonly subject: string },
): Promise<string> {
  return sha256Hex(`${stackId}\0${identity.identityIssuer}\0${identity.subject}`);
}

/** Stable canonical JSON for idempotency payload comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
