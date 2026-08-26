/**
 * Opaque CAS-generated identifiers. Never caller-chosen.
 * All identifiers are URL-safe so they can appear unescaped in paths.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** Stack namespace id, e.g. `cas_AbC...`. */
export function generateStackId(): string {
  return `cas_${randomBase64Url(12)}`;
}

export function generateInvitationId(): string {
  return `inv_${randomBase64Url(12)}`;
}

export function generateEventId(): string {
  return `evt_${randomBase64Url(12)}`;
}

export function generateSessionId(): string {
  return `sess_${randomBase64Url(24)}`;
}

/** High-entropy one-time invitation token; only its hash is stored. */
export function generateInvitationToken(): string {
  return randomBase64Url(32);
}

/** Possession-challenge nonce. */
export function generateNonce(): string {
  return randomBase64Url(16);
}
