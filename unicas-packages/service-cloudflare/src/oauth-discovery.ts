import {
  canonicalJson,
  canonicalizeOAuthIssuer,
  oauthDiscoveryCandidates,
  parseOAuthJwks,
  parseOAuthMetadata,
  sha256Hex,
  type OAuthDiscoveryPort,
  type OAuthDiscoveryResult,
} from "@unicas/service";

const METADATA_MAX_BYTES = 128 * 1024;
const JWKS_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CloudflareOAuthDiscoveryOptions {
  /** Explicit production allowlist; an empty set fails closed before fetch. */
  readonly allowedOrigins: readonly string[];
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

/** SSRF-hardened OAuth metadata/JWKS fetch adapter for the Cloudflare runtime. */
export class CloudflareOAuthDiscoveryPort implements OAuthDiscoveryPort {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CloudflareOAuthDiscoveryOptions) {
    this.#allowedOrigins = new Set(options.allowedOrigins.map(normalizeAllowedOrigin));
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async inspectIssuer(input: { readonly issuer: string }): Promise<OAuthDiscoveryResult> {
    const issuer = canonicalizeOAuthIssuer(input.issuer);
    this.#assertAllowedUrl(issuer, "issuer");

    let lastError: unknown;
    for (const candidate of oauthDiscoveryCandidates(issuer)) {
      try {
        this.#assertAllowedUrl(candidate.url, "metadata URL");
        const metadataDocument = await this.#fetchJson(candidate.url, METADATA_MAX_BYTES);
        const metadata = parseOAuthMetadata(metadataDocument, issuer, candidate);
        this.#assertAllowedUrl(metadata.jwksUri, "jwks_uri");
        const jwksDocument = await this.#fetchJson(metadata.jwksUri, JWKS_MAX_BYTES);
        const keys = parseOAuthJwks(jwksDocument);
        return {
          metadata,
          metadataDigest: await sha256Hex(canonicalJson(metadata)),
          jwksDigest: await sha256Hex(canonicalJson(keys)),
          keys,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new TypeError(`OAuth issuer discovery failed: ${errorMessage(lastError)}`);
  }

  #assertAllowedUrl(value: string, field: string): void {
    if (this.#allowedOrigins.size === 0) {
      throw new TypeError("OAuth discovery is disabled until allowed origins are configured");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError(`${field} must be an absolute URL`);
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
      throw new TypeError(`${field} must use HTTPS on the default port without credentials`);
    }
    if (isUnsafeHostname(url.hostname)) throw new TypeError(`${field} hostname is not allowed`);
    if (!this.#allowedOrigins.has(url.origin)) {
      throw new TypeError(`${field} origin is not allowlisted`);
    }
  }

  async #fetchJson(url: string, maxBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new TypeError("discovery redirects are not allowed");
      }
      if (!response.ok) throw new TypeError(`discovery endpoint returned HTTP ${response.status}`);
      const contentType = response.headers.get("Content-Type");
      if (contentType && !/(^|\s|;)application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
        throw new TypeError("discovery endpoint did not return JSON content");
      }
      const text = await readBoundedText(response, maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new TypeError("discovery endpoint returned invalid JSON");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new TypeError("discovery response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new TypeError("discovery response is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function normalizeAllowedOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || url.pathname !== "/" || url.search || url.hash || isUnsafeHostname(url.hostname)) {
    throw new TypeError("allowed OAuth discovery origins must be safe HTTPS origins");
  }
  return url.origin;
}

function isUnsafeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized === "metadata.google.internal"
    || normalized === "169.254.169.254"
    || isIpv4Address(normalized)
    || normalized.includes(":");
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
