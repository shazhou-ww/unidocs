import type { D1Database } from "@cloudflare/workers-types";
import { ADMIN_MCP_SCOPES } from "@unidocs/portal-service";
import type { AdminMcpAuthorizationTransactions, AdminMcpPendingAuthorization } from "./authorization.js";

const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const lifetime = 600;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface TextTransactionStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createAdminMcpAuthorizationTransactions(options: {
  readonly database: D1Database;
  readonly storage: TextTransactionStorage;
  readonly encryptionKey: string;
  readonly publicOrigin: string;
  readonly now?: () => number;
}): AdminMcpAuthorizationTransactions {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || origin.protocol !== "https:" || !opaquePattern.test(options.encryptionKey)) throw new TypeError("Invalid MCP authorization transaction configuration");
  const rawKey = decodeBase64Url(options.encryptionKey);
  if (rawKey.byteLength !== 32) throw new TypeError("Invalid MCP authorization transaction configuration");
  const keyPromise = crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async put(id, value) {
      if (!opaquePattern.test(id)) throw new Error("Invalid MCP authorization transaction");
      const createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("Invalid MCP authorization transaction clock");
      const checked = validatePending(value, origin.origin, createdAt);
      const digest = await sha256Hex(id);
      const storageKey = `admin-mcp-authorization:${digest}`;
      const initializationVector = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify({ createdAt, expiresAt: createdAt + lifetime, value: checked }));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: initializationVector, additionalData: encoder.encode(storageKey) }, await keyPromise, plaintext);
      await options.storage.put(storageKey, `${encodeBase64Url(initializationVector)}.${encodeBase64Url(new Uint8Array(ciphertext))}`, { expiration: createdAt + lifetime });
    },
    async take(id) {
      if (!opaquePattern.test(id)) return null;
      const digest = await sha256Hex(id);
      const storageKey = `admin-mcp-authorization:${digest}`;
      const sealed = await options.storage.get(storageKey);
      if (!sealed) return null;
      const parts = sealed.split(".");
      if (parts.length !== 2) throw new Error("Invalid MCP authorization transaction");
      let envelope: { createdAt: number; expiresAt: number; value: AdminMcpPendingAuthorization };
      try {
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(parts[0]), additionalData: encoder.encode(storageKey) }, await keyPromise, decodeBase64Url(parts[1]));
        const parsed: unknown = JSON.parse(decoder.decode(plaintext));
        if (!record(parsed) || !Number.isSafeInteger(parsed.createdAt) || !Number.isSafeInteger(parsed.expiresAt)
          || typeof parsed.createdAt !== "number" || typeof parsed.expiresAt !== "number" || parsed.createdAt < 0
          || parsed.expiresAt !== parsed.createdAt + lifetime || parsed.createdAt > now() || parsed.expiresAt <= now()) return null;
        envelope = { createdAt: parsed.createdAt, expiresAt: parsed.expiresAt, value: validatePending(parsed.value, origin.origin, parsed.createdAt) };
      } catch {
        throw new Error("Invalid MCP authorization transaction");
      }
      const result = await options.database.prepare(`INSERT INTO portal_mcp_authorization_transaction_consumptions (transaction_hash, consumed_at, expires_at)
        VALUES (?, ?, ?) ON CONFLICT(transaction_hash) DO NOTHING`).bind(digest, now(), envelope.expiresAt).run();
      if (!result.success) throw new Error("MCP authorization transaction consumption unavailable");
      if (result.meta.changes !== 1) return null;
      await options.storage.delete(storageKey);
      return envelope.value;
    },
  };
}

function validatePending(value: unknown, origin: string, createdAt: number): AdminMcpPendingAuthorization {
  if (!record(value) || (value.kind !== "session" && value.kind !== "consent")) throw new Error("Invalid MCP authorization transaction");
  const oauthRequest = value.oauthRequest;
  if (!record(oauthRequest) || oauthRequest.responseType !== "code" || typeof oauthRequest.clientId !== "string" || !oauthRequest.clientId
    || typeof oauthRequest.redirectUri !== "string" || typeof oauthRequest.state !== "string"
    || typeof oauthRequest.codeChallenge !== "string" || !opaquePattern.test(oauthRequest.codeChallenge) || oauthRequest.codeChallengeMethod !== "S256"
    || oauthRequest.resource !== `${origin}/mcp` || oauthRequest.issuer !== origin || !Array.isArray(oauthRequest.scope) || oauthRequest.scope.length === 0
    || !oauthRequest.scope.every(scope => typeof scope === "string" && (ADMIN_MCP_SCOPES as readonly string[]).includes(scope))) throw new Error("Invalid MCP authorization transaction");
  try { new URL(oauthRequest.redirectUri); } catch { throw new Error("Invalid MCP authorization transaction"); }
  if (value.kind === "session") return value as unknown as AdminMcpPendingAuthorization;
  if (typeof value.memberId !== "string" || !value.memberId || typeof value.clientName !== "string" || !value.clientName.trim() || value.clientName.length > 256
    || typeof value.csrfToken !== "string" || !opaquePattern.test(value.csrfToken) || typeof value.authorizedAt !== "number" || !Number.isSafeInteger(value.authorizedAt)
    || value.authorizedAt > createdAt || createdAt - value.authorizedAt > 5 || !record(value.identity)
    || typeof value.identity.issuer !== "string" || typeof value.identity.subject !== "string" || typeof value.identity.email !== "string"
    || (value.identity.authenticatedAt !== null && typeof value.identity.authenticatedAt !== "number")
    || (value.identity.loginConfirmedAt !== undefined && typeof value.identity.loginConfirmedAt !== "number")
    || (value.identity.loginConfirmation !== undefined && value.identity.loginConfirmation !== "authorization-code-v1")) throw new Error("Invalid MCP authorization transaction");
  return value as unknown as AdminMcpPendingAuthorization;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
  if (!digestPattern.test(hash)) throw new Error("Invalid transaction digest");
  return hash;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1 || value.length > 32_768) throw new TypeError("Invalid base64url value");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== value) throw new TypeError("Invalid base64url value");
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}