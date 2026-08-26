/**
 * BFF session state: encrypted payloads, opaque session ids, and cookies.
 *
 * The session payload holds the verified operator identity (iss, sub) plus
 * pre-login OIDC material (state, nonce, PKCE verifier, return path) and the
 * CSRF token. Payloads are encrypted with AES-256-GCM (JWE `dir`/`A256GCM`)
 * using versioned keys from config; new sessions use the newest key and old
 * keys decrypt until retired.
 */

import { EncryptJWT, jwtDecrypt } from "jose";

export interface AdminSessionPayload {
  readonly v: 1;
  /** true once a Google identity has been verified into this session. */
  readonly authenticated: boolean;
  readonly identityIssuer: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly emailForDisplay: string | null;
  readonly csrfToken: string;
  /** Pre-login OIDC authorization state (login in progress). */
  readonly oidcState?: string;
  readonly oidcNonce?: string;
  readonly codeVerifier?: string;
  readonly returnTo?: string;
}

export class SessionCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCryptoError";
  }
}

export class SessionCrypto {
  readonly #keys: ReadonlyMap<string, Uint8Array>;
  /** Newest key id; used for new sessions. */
  readonly #newestKid: string;

  constructor(keys: Readonly<Record<string, string>>) {
    const entries = Object.entries(keys);
    if (entries.length === 0) throw new SessionCryptoError("no session encryption keys");
    const map = new Map<string, Uint8Array>();
    for (const [kid, key] of entries) {
      let bytes: Uint8Array;
      try {
        bytes = base64UrlDecode(key);
      } catch {
        throw new SessionCryptoError(`session key '${kid}' is not valid base64url`);
      }
      if (bytes.length !== 32) {
        throw new SessionCryptoError(`session key '${kid}' must be 32 bytes (AES-256)`);
      }
      map.set(kid, bytes);
    }
    this.#keys = map;
    // The last key in the map is treated as the newest.
    this.#newestKid = entries[entries.length - 1]![0];
  }

  async encrypt(payload: AdminSessionPayload): Promise<string> {
    const key = this.#keys.get(this.#newestKid)!;
    return new EncryptJWT({ ...payload })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: this.#newestKid })
      .encrypt(key);
  }

  async decrypt(jwe: string): Promise<AdminSessionPayload> {
    let lastError: unknown = null;
    for (const [kid, key] of this.#keys) {
      try {
        const { payload } = await jwtDecrypt(jwe, key, {
          keyManagementAlgorithms: ["dir"],
          contentEncryptionAlgorithms: ["A256GCM"],
        });
        if (payload.v !== 1 || typeof payload.subject !== "string") {
          throw new SessionCryptoError("session payload shape is invalid");
        }
        return payload as unknown as AdminSessionPayload;
      } catch (error) {
        lastError = error;
      }
    }
    throw new SessionCryptoError("session could not be decrypted with any key");
  }
}

// ----------------------------------------------------------------------
// Cookies
// ----------------------------------------------------------------------

export interface SessionCookieOptions {
  readonly name: string;
  readonly secure: boolean;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly maxAgeSeconds?: number;
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie");
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) out[name] = value;
  }
  return out;
}

export function sessionCookieHeader(
  options: SessionCookieOptions,
  value: string,
): string {
  const parts = [
    `${options.name}=${value}`,
    "Path=/admin",
    "HttpOnly",
  ];
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function clearSessionCookie(options: SessionCookieOptions): string {
  return sessionCookieHeader(options, "") + "; Max-Age=0";
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

export function generateCsrfToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function generateSessionId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sess_${base64UrlEncode(bytes)}`;
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
