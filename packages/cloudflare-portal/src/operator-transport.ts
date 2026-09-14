export const OPERATOR_DISCOVERY_PATH = "/.well-known/unidocs-operator";
export const OPERATOR_IO_LIMITS = Object.freeze({ timeoutMs: 5_000, responseBytes: 65_536, probeBytes: 16_384 });

export class OperatorTransportError extends Error {
  constructor() {
    super("Operator request failed or target is not permitted");
    this.name = "OperatorTransportError";
  }
}

export interface OperatorServiceTarget {
  readonly baseUrl: string;
  readonly probePath: string;
  readonly service: { fetch(request: Request): Promise<Response> };
}

export interface OperatorTransportResponse {
  readonly body: Uint8Array;
  readonly etag: string | null;
  readonly proofHeaders: Readonly<Record<string, string>>;
}

function canonicalBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || /[%\\\s]/.test(value)) throw new OperatorTransportError();
  const baseUrl = url.href.replace(/\/$/, "");
  if (value !== baseUrl || url.hostname.endsWith(".") || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new OperatorTransportError();
  return baseUrl;
}

/**
 * A path on the Operator's origin. A configured probe path is literal, so it
 * admits no `%` at all; a webhook path carries `encodeURIComponent`-escaped
 * tenant and document ids, so it admits well-formed `%XX` escapes. Either way
 * the path must survive URL parsing unchanged, which rules out dot segments
 * (`%2e%2e` included, since the parser folds those too).
 */
function canonicalPath(value: string, escapes: "none" | "percent-encoded" = "none"): string {
  const parsed = new URL(value, "https://operator.invalid");
  const badEscape = escapes === "none" ? /%/.test(value) : /%(?![0-9A-Fa-f]{2})/.test(value);
  if (!value.startsWith("/") || value.startsWith("//") || value === "/" || badEscape || /[\\\s?#]/.test(value) || parsed.origin !== "https://operator.invalid" || parsed.pathname !== value || value.includes("//") || value === OPERATOR_DISCOVERY_PATH) throw new OperatorTransportError();
  return value;
}

/**
 * The request headers a caller may add to a probe or a webhook: `x-unidocs-`
 * names only, bounded, printable, and never a delegated credential. Shared by
 * both operations so the rules cannot drift apart.
 */
function setOperatorHeaders(headers: Headers, extra: Readonly<Record<string, string>>): void {
  let bytes = 0;
  for (const [name, value] of Object.entries(extra)) {
    bytes += name.length + value.length;
    if (!/^x-unidocs-[a-z0-9-]+$/.test(name) || name.length > 128 || value.length > 1024 || bytes > 8192 || /[^\x20-\x7e]/.test(value) || name === "x-unidocs-cas-authorization" || name === "x-unidocs-platform-authorization") throw new OperatorTransportError();
    headers.set(name, value);
  }
}

export function createBoundOperatorTransport(targets: readonly OperatorServiceTarget[], timeoutMs: number = OPERATOR_IO_LIMITS.timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OPERATOR_IO_LIMITS.timeoutMs) throw new RangeError("Invalid Operator timeout");
  const allowed = new Map<string, OperatorServiceTarget>();
  for (const target of targets) {
    const baseUrl = canonicalBaseUrl(target.baseUrl);
    const probePath = canonicalPath(target.probePath);
    if (allowed.has(baseUrl)) throw new TypeError("Duplicate Operator target");
    allowed.set(baseUrl, { baseUrl, probePath, service: target.service });
  }

  async function send(baseUrl: string, operation: "discovery" | "probe" | "webhook", body?: Uint8Array, proofHeaders?: Readonly<Record<string, string>>, webhookPath?: string): Promise<OperatorTransportResponse> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    let deadlineExpired = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = allowed.get(canonicalBaseUrl(baseUrl));
      if (!target) throw new OperatorTransportError();
      if (operation === "probe" && (!body || body.byteLength > OPERATOR_IO_LIMITS.probeBytes)) throw new OperatorTransportError();
      if (operation === "webhook" && !body) throw new OperatorTransportError();
      const path = operation === "discovery" ? OPERATOR_DISCOVERY_PATH
        : operation === "probe" ? target.probePath
        : canonicalPath(webhookPath ?? "", "percent-encoded");
      const headers = new Headers({ Accept: "application/json" });
      if (operation !== "discovery") {
        headers.set("Content-Type", "application/json");
        setOperatorHeaders(headers, proofHeaders ?? {});
      }
      const request = new Request(`${target.baseUrl}${path}`, {
        method: operation === "discovery" ? "GET" : "POST",
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          deadlineExpired = true;
          controller.abort();
          if (reader) void reader.cancel().catch(() => {});
          reject(new OperatorTransportError());
        }, timeoutMs);
      });
      const pending = target.service.fetch(request).then(response => {
        if (deadlineExpired) {
          void response.body?.cancel().catch(() => {});
          throw new OperatorTransportError();
        }
        return response;
      });
      const response = await Promise.race([pending, deadline]);
      if (response.body) reader = response.body.getReader();
      if (response.status !== 200 || response.redirected || !reader || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new OperatorTransportError();
      const content = new Uint8Array(OPERATOR_IO_LIMITS.responseBytes);
      let size = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (deadlineExpired) throw new OperatorTransportError();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > content.byteLength) throw new OperatorTransportError();
        content.set(chunk.value, size - chunk.value.byteLength);
      }
      complete = true;
      const probeSignature = operation === "probe" ? response.headers.get("x-unidocs-probe-signature") : null;
      if (probeSignature !== null && !/^[A-Za-z0-9_-]{43}$/.test(probeSignature)) throw new OperatorTransportError();
      return {
        body: content.slice(0, size),
        etag: response.headers.get("etag"),
        proofHeaders: probeSignature === null ? {} : { "x-unidocs-probe-signature": probeSignature },
      };
    } catch {
      throw new OperatorTransportError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (!complete) {
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
      }
      reader?.releaseLock();
    }
  }

  return {
    discovery: (baseUrl: string) => send(baseUrl, "discovery"),
    probe: (baseUrl: string, body: Uint8Array, proofHeaders: Readonly<Record<string, string>>) => send(baseUrl, "probe", body, proofHeaders),
    /** POST `body` to `baseUrl + path`; `path` may carry percent-encoded segments. */
    webhook: (baseUrl: string, path: string, body: Uint8Array, headers: Readonly<Record<string, string>>) => send(baseUrl, "webhook", body, headers, path),
  };
}