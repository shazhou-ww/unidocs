/**
 * `createGatewayHandler`'s `forwardToWorker` proxies a request onward with a
 * bare `fetch(targetUrl, { ..., body: request.body })` — no `new Request()`
 * in between. Node's `fetch` (undici) validates streaming bodies
 * independently of `Request`'s own constructor, so this needs its own
 * `duplex: "half"` even though `doc-type-handler.test.ts` already covers the
 * `new Request(...)` shape. Before that was added (task-7 review finding 1),
 * this surfaced as a 502 "Document worker unreachable" wrapping undici's
 * "duplex option is required" TypeError.
 *
 * Uses a real `node:http` server as the "upstream doc-type worker" — the
 * duplex requirement only triggers for a genuine streaming body, and a
 * plain in-process fetch mock wouldn't exercise Node's real body-consuming
 * path the way an actual socket read does.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayHandler } from "../src/gateway-handler.js";
import type { DocRecord } from "@unidocs/http-protocol";

/** A body that is a genuine `ReadableStream`, not an already-buffered string. */
function streamBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

let upstream: Server | undefined;

afterEach(async () => {
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
});

/** Starts a tiny upstream HTTP server that echoes the request body back as JSON, on a free port. */
function startUpstream(): Promise<number> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream!.address();
      if (address === null || typeof address === "string") throw new Error("no port assigned");
      resolve(address.port);
    });
  });
}

const INTERNAL_TOKEN = "test-token";

describe("createGatewayHandler — forwardToWorker streaming body", () => {
  it("forwards a POST body intact through a bare fetch() to the resolved worker URL", async () => {
    const port = await startUpstream();

    const handler = createGatewayHandler({
      internalToken: INTERNAL_TOKEN,
      resolveWorkerUrl: async (docType) =>
        docType === "markdown" ? `http://127.0.0.1:${port}` : null,
      casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
      docIndex: {
        list: async (): Promise<DocRecord[]> => [],
        snapshots: async () => [],
      },
      isPublicCasRoute: () => false,
    });

    const payload = "# hello from a real stream";
    const incoming = new Request("http://gw.local/users/u1/docs/markdown/", {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: streamBody(payload),
      duplex: "half",
    } as RequestInit);

    const res = await handler(incoming);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ echoed: payload });
  });
});
