/**
 * Node HTTP shell: bridges `node:http` to the WHATWG `Request`/`Response`
 * handlers that `@unidocs/server-core` exports (`createDocTypeHandler`,
 * `createSessionHandler`, `createGatewayHandler`). Node 24 has native
 * `Request`/`Response`/`FormData`/`Headers`, so no polyfill is needed — this
 * file only does the plumbing: turn an `IncomingMessage` into a `Request`,
 * write a `Response` back onto a `ServerResponse`.
 *
 * ## The duplex patch
 *
 * `createDocTypeHandler` and `createGatewayHandler` (server-core, not
 * modified by this package) forward a request two different ways, both of
 * which stream the incoming body onward:
 *
 *   - doc-type-handler.ts: `new Request(forwardUrl, { method, headers, body:
 *     request.body })`
 *   - gateway-handler.ts's `forwardToWorker`: `fetch(targetUrl, { method,
 *     headers, body: request.body })`
 *
 * Both were written against Cloudflare Workers, where neither `Request` nor
 * `fetch` needs anything extra for a streaming body. Node's own
 * implementation (undici) additionally REQUIRES `duplex: "half"` on the init
 * whenever `body` is a stream, for `new Request(...)` AND for a bare
 * `fetch(url, init)` call independently (each does its own validation before
 * either one hits shared code) — and throws synchronously otherwise
 * ("RequestInit: duplex option is required when sending a body"). Every
 * multi-hop forward in this codebase — Gateway → doc-type worker, doc-type
 * worker → the local editor "DO" stub — goes through one of these two
 * shapes, so without a fix, every POST with a body (create, apply, rollback,
 * init_from_hash, query) would throw before reaching this package's own
 * code, or (for the Gateway hop specifically) surface as a 502 "Document
 * worker unreachable" wrapping that same TypeError.
 *
 * server-core is intentionally not touched to work around this (it stays
 * correct and minimal for its actual target, Cloudflare's `Request`/`fetch`).
 * Instead this module patches both `globalThis.Request` and `globalThis.fetch`
 * — once, at import time, for the lifetime of the Node process — to fill in
 * `duplex: "half"` whenever a body is present and the caller didn't already
 * specify one. This is additive only: any call site that already passes an
 * explicit `duplex` (or has no body at all — GET/HEAD, a `null` body, or a
 * `fetch(existingRequest)` call with no `init`, which needs no patch since
 * the Request's own construction already carries whatever duplex it was
 * built with) is untouched, so there is no behavior change outside of the
 * case that would otherwise be a hard crash.
 *
 * Verified end-to-end (including a multipart `FormData` re-wrapped twice —
 * the shape `POST /users/{userId}/` create actually takes — and the full
 * Gateway → doc-type-worker → local-editor hop with a real `fetch()` in the
 * middle) that this patch makes both forwarding shapes behave like a direct,
 * single-hop `fetch()` call.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const NativeRequest = globalThis.Request;

class DuplexSafeRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init && init.body != null && !("duplex" in init)) {
      super(input, { ...init, duplex: "half" } as RequestInit);
    } else {
      super(input, init);
    }
  }
}

const nativeFetch = globalThis.fetch;

function duplexSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init && init.body != null && !("duplex" in init)) {
    return nativeFetch(input, { ...init, duplex: "half" } as RequestInit);
  }
  return nativeFetch(input, init);
}

// Only patch once — re-importing this module (or another copy of it from a
// duplicate install) must not wrap an already-patched global again.
if (globalThis.Request !== DuplexSafeRequest) {
  globalThis.Request = DuplexSafeRequest as unknown as typeof Request;
}
if (globalThis.fetch !== duplexSafeFetch) {
  globalThis.fetch = duplexSafeFetch as typeof fetch;
}

export interface ServeOptions {
  port: number;
  host?: string;
}

export interface ServeHandle {
  close(): Promise<void>;
}

/** Methods for which a `Request` must not carry a body (Fetch spec). */
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

function toWebRequest(req: IncomingMessage, defaultHost: string): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const hostHeader = req.headers.host ?? defaultHost;
  const url = new URL(req.url ?? "/", `http://${hostHeader}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }

  const init: RequestInit = { method, headers };
  if (!BODYLESS_METHODS.has(method)) {
    // `Readable.toWeb` gives back `node:stream/web`'s `ReadableStream`, which
    // is structurally the Fetch spec's stream but a separately-declared type
    // from lib.dom's `ReadableStream` — same runtime value, different .d.ts.
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  }

  return new Request(url, init);
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  // Same lib.dom vs. node:stream/web split as toWebRequest, in reverse.
  const nodeStream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  await new Promise<void>((resolve, reject) => {
    res.on("error", reject);
    nodeStream.on("error", reject);
    nodeStream.pipe(res);
    res.on("finish", resolve);
  });
}

/**
 * Start a plain `node:http` server that hands every request to `handler` as a
 * Web `Request` and writes back whatever `Response` it resolves to.
 *
 * `handler` throwing is treated as an unexpected server error (500 JSON) —
 * every documented failure mode of the server-core handlers already resolves
 * to a `Response` of its own via `errorResponse`, so a throw here means the
 * handler itself is broken, not that the request was invalid.
 */
export function serve(
  handler: (req: Request) => Promise<Response>,
  opts: ServeOptions,
): Promise<ServeHandle> {
  const host = opts.host ?? "0.0.0.0";
  const defaultHost = `${host}:${opts.port}`;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = toWebRequest(req, defaultHost);
        const response = await handler(request);
        await writeWebResponse(response, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `Unhandled error: ${String(err)}` }));
        } else {
          res.destroy();
        }
      }
    })();
  });

  return new Promise<ServeHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      resolve({
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
