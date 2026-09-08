import { DoctypeProtocol, HmacAlgorithm, SValueContentType } from "@unidocs/protocol-doctype";
import type { PlatformRequestAuthentication, ServiceRole } from "@unidocs/protocol-doctype";

export const PlatformHmacHeaders = {
  protocol: "x-unidocs-protocol",
  algorithm: "x-unidocs-algorithm",
  keyId: "x-unidocs-key-id",
  platformId: "x-unidocs-platform-id",
  environment: "x-unidocs-environment",
  serviceId: "x-unidocs-service-id",
  role: "x-unidocs-role",
  issuedAt: "x-unidocs-issued-at",
  expiresAt: "x-unidocs-expires-at",
  nonce: "x-unidocs-nonce",
  signature: "x-unidocs-signature",
} as const;
export const CasAuthorizationHeader = "x-unidocs-cas-authorization";
export const PlatformDelegationHeader = "x-unidocs-platform-authorization";

export interface PlatformHmacKey {
  readonly keyId: string;
  readonly platformId: string;
  readonly environment: string;
  readonly serviceId: string;
  readonly role: ServiceRole;
  readonly key: CryptoKey;
}

export interface PlatformHmacTarget {
  readonly origin: string;
  readonly paths: readonly string[];
}

export interface PlatformNonceStore {
  claim(scope: string, nonce: string, retainUntil: number): Promise<boolean>;
}

export class PlatformHmacError extends Error {
  constructor(readonly code: "unauthorized" | "replay_detected" | "unavailable" | "limit_exceeded") {
    super(code);
    this.name = "PlatformHmacError";
  }
}

export interface VerifyPlatformRequestOptions {
  readonly target: PlatformHmacTarget;
  readonly keys: readonly PlatformHmacKey[];
  readonly nonces: PlatformNonceStore;
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
}

export interface VerifiedPlatformRequest {
  readonly authentication: Omit<PlatformRequestAuthentication, "signature">;
  readonly body: Uint8Array;
  readonly casAuthorization: string | null;
  readonly platformAuthorization: string | null;
}

const encoder = new TextEncoder();
const tokenPattern = /^[A-Za-z0-9_-]{1,128}$/;
const maximumLifetime = 300;
const clockSkew = 30;

export async function importPlatformHmacKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength < 32) throw new TypeError("HMAC keys require at least 32 random bytes");
  return crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signPlatformRequest(options: {
  readonly url: string;
  readonly target: PlatformHmacTarget;
  readonly key: PlatformHmacKey;
  readonly body: Uint8Array;
  readonly casAuthorization?: string | null;
  readonly platformAuthorization?: string | null;
  readonly now?: () => number;
  readonly lifetimeSeconds?: number;
}): Promise<Request> {
  const url = checkedUrl(options.url, options.target);
  const issuedAt = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const lifetime = options.lifetimeSeconds ?? 60;
  const authentication: PlatformRequestAuthentication = {
    protocol: DoctypeProtocol,
    algorithm: HmacAlgorithm,
    keyId: options.key.keyId,
    platformId: options.key.platformId,
    environment: options.key.environment,
    serviceId: options.key.serviceId,
    role: options.key.role,
    issuedAt,
    expiresAt: issuedAt + lifetime,
    nonce: crypto.randomUUID(),
    signature: "",
  };
  validateAuthentication(authentication, issuedAt);
  const casAuthorization = checkedCredential(options.casAuthorization ?? null);
  const platformAuthorization = checkedCredential(options.platformAuthorization ?? null);
  if (authentication.role === "editor" && platformAuthorization !== null) throw new PlatformHmacError("unauthorized");
  const body = new Uint8Array(options.body);
  const canonical = await canonicalRequest(url, authentication, body, casAuthorization, platformAuthorization);
  const signed = { ...authentication, signature: hex(await crypto.subtle.sign("HMAC", options.key.key, canonical)) };
  const headers = new Headers({ "content-type": SValueContentType });
  for (const [field, header] of Object.entries(PlatformHmacHeaders)) {
    headers.set(header, String(signed[field as keyof PlatformRequestAuthentication]));
  }
  if (casAuthorization !== null) headers.set(CasAuthorizationHeader, casAuthorization);
  if (platformAuthorization !== null) headers.set(PlatformDelegationHeader, platformAuthorization);
  return new Request(url, { method: "POST", headers, body, redirect: "manual" });
}

export async function verifyPlatformRequest(
  request: Request,
  options: VerifyPlatformRequestOptions,
): Promise<VerifiedPlatformRequest> {
  const url = checkedUrl(request.url, options.target);
  if (request.method !== "POST" || request.headers.get("content-type") !== SValueContentType
    || request.headers.has("authorization") || request.headers.has("cookie")
    || request.headers.has("content-encoding")) throw new PlatformHmacError("unauthorized");
  const allowedHeaders = new Set<string>([
    ...Object.values(PlatformHmacHeaders), CasAuthorizationHeader, PlatformDelegationHeader,
  ]);
  request.headers.forEach((_value, name) => {
    if (name.startsWith("x-unidocs-") && !allowedHeaders.has(name)) throw new PlatformHmacError("unauthorized");
  });
  const authentication = readAuthentication(request.headers);
  const now = (options.now ?? (() => Date.now() / 1000))();
  validateAuthentication(authentication, now);
  const candidates = options.keys.filter((key) => key.keyId === authentication.keyId
    && key.platformId === authentication.platformId && key.environment === authentication.environment
    && key.serviceId === authentication.serviceId && key.role === authentication.role);
  if (candidates.length !== 1) throw new PlatformHmacError("unauthorized");
  const casAuthorization = checkedCredential(request.headers.get(CasAuthorizationHeader));
  const platformAuthorization = checkedCredential(request.headers.get(PlatformDelegationHeader));
  if (authentication.role === "editor" && platformAuthorization !== null) throw new PlatformHmacError("unauthorized");
  const body = await readBoundedBody(request, options.maxBodyBytes ?? 1_048_576);
  const canonical = await canonicalRequest(url, authentication, body, casAuthorization, platformAuthorization);
  const signature = Uint8Array.from(authentication.signature.match(/../g)!, (pair) => parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", candidates[0].key, signature, canonical)) {
    throw new PlatformHmacError("unauthorized");
  }
  validateAuthentication(authentication, (options.now ?? (() => Date.now() / 1000))());
  const scope = JSON.stringify([
    authentication.platformId, authentication.environment, authentication.serviceId, authentication.role,
  ]);
  let claimed: boolean;
  try {
    claimed = await options.nonces.claim(scope, authentication.nonce, authentication.expiresAt + clockSkew);
  } catch {
    throw new PlatformHmacError("unavailable");
  }
  if (claimed !== true) throw new PlatformHmacError("replay_detected");
  validateAuthentication(authentication, (options.now ?? (() => Date.now() / 1000))());
  const { signature: _signature, ...metadata } = authentication;
  return { authentication: metadata, body, casAuthorization, platformAuthorization };
}

function checkedUrl(input: string, target: PlatformHmacTarget): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new PlatformHmacError("unauthorized"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || url.origin !== target.origin || !target.paths.includes(url.pathname)
    || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || input.includes("?") || input.includes("#") || url.href !== input) {
    throw new PlatformHmacError("unauthorized");
  }
  return url;
}

function checkedCredential(value: string | null): string | null {
  if (value !== null && (value.length > 8192 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value) || value.includes(","))) {
    throw new PlatformHmacError("unauthorized");
  }
  return value;
}

function readAuthentication(headers: Headers): PlatformRequestAuthentication {
  const read = (field: keyof typeof PlatformHmacHeaders): string => {
    const value = headers.get(PlatformHmacHeaders[field]);
    if (value === null) throw new PlatformHmacError("unauthorized");
    return value;
  };
  const issuedAt = read("issuedAt");
  const expiresAt = read("expiresAt");
  if (!/^(0|[1-9][0-9]*)$/.test(issuedAt) || !/^(0|[1-9][0-9]*)$/.test(expiresAt)) throw new PlatformHmacError("unauthorized");
  const authentication = {
    protocol: read("protocol"), algorithm: read("algorithm"), keyId: read("keyId"),
    platformId: read("platformId"), environment: read("environment"), serviceId: read("serviceId"),
    role: read("role"), issuedAt: Number(issuedAt), expiresAt: Number(expiresAt),
    nonce: read("nonce"), signature: read("signature"),
  };
  if (authentication.protocol !== DoctypeProtocol || authentication.algorithm !== HmacAlgorithm
    || (authentication.role !== "editor" && authentication.role !== "operator")
    || !/^[a-f0-9]{64}$/.test(authentication.signature)) throw new PlatformHmacError("unauthorized");
  return authentication as PlatformRequestAuthentication;
}

function validateAuthentication(authentication: PlatformRequestAuthentication, now: number): void {
  if (![authentication.keyId, authentication.platformId, authentication.environment, authentication.serviceId, authentication.nonce].every((value) => tokenPattern.test(value))
    || !["editor", "operator"].includes(authentication.role)
    || !Number.isSafeInteger(authentication.issuedAt) || authentication.issuedAt < 0
    || !Number.isSafeInteger(authentication.expiresAt) || !Number.isFinite(now)
    || authentication.expiresAt <= authentication.issuedAt
    || authentication.expiresAt - authentication.issuedAt > maximumLifetime
    || authentication.issuedAt > now + clockSkew || authentication.expiresAt + clockSkew <= now) {
    throw new PlatformHmacError("unauthorized");
  }
}

async function canonicalRequest(
  url: URL,
  authentication: PlatformRequestAuthentication,
  body: Uint8Array,
  casAuthorization: string | null,
  platformAuthorization: string | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const fields = [
    "unidocs-hmac/1", authentication.protocol, authentication.algorithm,
    authentication.keyId, authentication.platformId, authentication.environment,
    authentication.serviceId, authentication.role, "POST", url.origin, url.pathname, "",
    SValueContentType, await digest(body), String(authentication.issuedAt), String(authentication.expiresAt),
    authentication.nonce,
    casAuthorization === null ? "absent" : await digest(encoder.encode(casAuthorization)),
    platformAuthorization === null ? "absent" : await digest(encoder.encode(platformAuthorization)),
  ];
  return encoder.encode(fields.map((field) => `${encoder.encode(field).length}:${field}`).join(""));
}

async function digest(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new TypeError("Invalid request body limit");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
    throw new PlatformHmacError("limit_exceeded");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new PlatformHmacError("limit_exceeded");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}