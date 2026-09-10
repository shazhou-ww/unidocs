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
}

function canonicalBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || /[%\\\s]/.test(value)) throw new OperatorTransportError();
  const baseUrl = url.href.replace(/\/$/, "");
  if (value !== baseUrl || url.hostname.endsWith(".") || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new OperatorTransportError();
  return baseUrl;
}

function canonicalProbePath(value: string): string {
  const parsed = new URL(value, "https://operator.invalid");
  if (!value.startsWith("/") || value.startsWith("//") || value === "/" || /[%\\\s?#]/.test(value) || parsed.origin !== "https://operator.invalid" || parsed.pathname !== value || value.includes("//") || value === OPERATOR_DISCOVERY_PATH) throw new OperatorTransportError();
  return value;
}

export function createBoundOperatorTransport(targets: readonly OperatorServiceTarget[], timeoutMs: number = OPERATOR_IO_LIMITS.timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OPERATOR_IO_LIMITS.timeoutMs) throw new RangeError("Invalid Operator timeout");
  const allowed = new Map<string, OperatorServiceTarget>();
  for (const target of targets) {
    const baseUrl = canonicalBaseUrl(target.baseUrl);
    const probePath = canonicalProbePath(target.probePath);
    if (allowed.has(baseUrl)) throw new TypeError("Duplicate Operator target");
    allowed.set(baseUrl, { baseUrl, probePath, service: target.service });
  }

  async function send(baseUrl: string, operation: "discovery" | "probe", body?: Uint8Array, proofHeaders?: Readonly<Record<string, string>>): Promise<OperatorTransportResponse> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    let deadlineExpired = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = allowed.get(canonicalBaseUrl(baseUrl));
      if (!target) throw new OperatorTransportError();
      if (operation === "probe" && (!body || body.byteLength > OPERATOR_IO_LIMITS.probeBytes)) throw new OperatorTransportError();
      const headers = new Headers({ Accept: "application/json" });
      if (operation === "probe") {
        headers.set("Content-Type", "application/json");
        let proofBytes = 0;
        for (const [name, value] of Object.entries(proofHeaders ?? {})) {
          proofBytes += name.length + value.length;
          if (!/^x-unidocs-[a-z0-9-]+$/.test(name) || name.length > 128 || value.length > 1024 || proofBytes > 8192 || /[^\x20-\x7e]/.test(value) || name === "x-unidocs-cas-authorization" || name === "x-unidocs-platform-authorization") throw new OperatorTransportError();
          headers.set(name, value);
        }
      }
      const request = new Request(`${target.baseUrl}${operation === "discovery" ? OPERATOR_DISCOVERY_PATH : target.probePath}`, {
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
      return { body: content.slice(0, size), etag: response.headers.get("etag") };
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
  };
}