/**
 * Node HTTP shell: bridges `node:http` to the WHATWG `Request`/`Response`
 * handlers that `@unidocs/doctype-server-common` exports (`createDocTypeHandler`,
 * `createSessionHandler`, `createGatewayHandler`). Node 24 has native
 * `Request`/`Response`/`FormData`/`Headers`, so no polyfill is needed — this
 * file only does the plumbing: turn an `IncomingMessage` into a `Request`,
 * write a `Response` back onto a `ServerResponse`.
 *
 * A note on streaming bodies: Node's `Request`/`fetch` (undici) require
 * `duplex: "half"` on the init whenever `body` is a stream, and throw
 * synchronously otherwise. `toWebRequest` below sets it when it constructs
 * the inbound `Request`. server-core's own forwarding code
 * (`doc-type-handler.ts`, `gateway-handler.ts`) sets it too, at each of its
 * `new Request(...)`/`fetch(...)` call sites — verified against workerd
 * (Miniflare, `compatibilityDate: 2025-08-01`) that an explicit
 * `duplex: "half"` is accepted there as well, so this is not a Node-only
 * branch in that shared code.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

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
    // See the module doc: undici requires this whenever `body` is a stream.
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
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
    // Before `listen()` succeeds, an `error` here (EADDRINUSE, EACCES, ...)
    // should reject the caller's `serve()` promise.
    const onStartupError = (err: Error): void => reject(err);
    server.once("error", onStartupError);

    server.listen(opts.port, host, () => {
      server.removeListener("error", onStartupError);
      // The server must keep AT LEAST one `error` listener for the rest of
      // its life: EventEmitter treats an unhandled `error` event as an
      // uncaught exception and kills the process, and a running HTTP server
      // can still emit one post-listen (a bad client socket, EMFILE under
      // load, ...). Log instead of crashing the whole process over one
      // connection-level error.
      server.on("error", (err) => {
        console.error("azure-sdk serve(): server error", err);
      });

      resolve({
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
