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
import { MemoryGatewayDocumentDirectory } from "../src/document-directory.js";

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
let upstreamPath: string | undefined;
let upstreamHeaders: Record<string, string | string[] | undefined> | undefined;
let upstreamBody: string | undefined;

afterEach(async () => {
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
    upstreamPath = undefined;
    upstreamHeaders = undefined;
    upstreamBody = undefined;
  }
});

/** Starts a tiny upstream HTTP server that echoes the request body back as JSON, on a free port. */
function startUpstream(): Promise<number> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      upstreamPath = req.url;
      upstreamHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        upstreamBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          docId: "internal-session",
          version: 1,
          echoed: upstreamBody,
        }));
      });
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream!.address();
      if (address === null || typeof address === "string") throw new Error("no port assigned");
      resolve(address.port);
    });
  });
}

const CAS_ACCESS_KEY = "cas-key";
const DOC_ACCESS_KEY = "markdown-key";

describe("createGatewayHandler — forwardToWorker streaming body", () => {
  it("fails startup when the internal auth mode is absent", () => {
    expect(() => createGatewayHandler({
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: { resolve: async () => null },
      resolveDocService: async () => null,
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
    } as never)).toThrow("Gateway internal auth mode must be explicit");
  });

  it("forwards a POST body intact through a bare fetch() to the resolved worker URL", async () => {
    const port = await startUpstream();

    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => ({
          userId: "authenticated-user",
          tenantId: requestedTenantId,
          canManageTenant: true,
        }),
      },
      resolveDocService: async (docType) => docType === "markdown" ? {
        serviceId: "markdown-primary",
        url: `http://127.0.0.1:${port}`,
        accessKey: DOC_ACCESS_KEY,
      } : null,
      casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
      generateId: (() => {
        const ids = ["public-doc", "internal-session"];
        return () => ids.shift()!;
      })(),
      now: () => 100,
    });

    const payload = "# hello from a real stream";
    const incoming = new Request("http://gw.local/tenants/tenant-1/docs/markdown/", {
      method: "POST",
      headers: {
        "content-type": "text/markdown",
        Authorization: "Bearer end-user-token",
        Cookie: "session=end-user-cookie",
        "X-User-Id": "forged-user",
      },
      body: streamBody(payload),
      duplex: "half",
    } as RequestInit);

    const res = await handler(incoming);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      docId: "public-doc",
      version: 1,
    });
    expect(body.sessionId).toBeUndefined();
    expect(upstreamBody).toBe(payload);
    expect(upstreamPath).toBe("/sessions/internal-session");
    expect(upstreamHeaders?.["x-session-id"]).toBe("internal-session");
    expect(upstreamHeaders?.["x-tenant-id"]).toBe("tenant-1");
    expect(upstreamHeaders?.["x-internal-token"]).toBe(DOC_ACCESS_KEY);
    expect(upstreamHeaders?.["x-user-id"]).toBeUndefined();
    expect(upstreamHeaders?.authorization).toBeUndefined();
    expect(upstreamHeaders?.cookie).toBeUndefined();
  });

  it("forwards a public tenant CAS request with minimal headers", async () => {
    let forwarded: Request | undefined;
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => requestedTenantId === "tenant-42" ? {
          userId: "authenticated-user",
          tenantId: "tenant-42",
          canManageTenant: true,
        } : null,
      },
      resolveDocService: async () => null,
      casFetcher: {
        fetch: async (request) => {
          forwarded = request as Request;
          return new Response(null, { status: 204 });
        },
      },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => true,
    });

    const res = await handler(new Request("http://gw.local/tenants/tenant-42/cas/usage", {
      headers: {
        Authorization: "Bearer end-user-token",
        Cookie: "session=end-user-cookie",
        "X-Tenant-Id": "attacker-selected-tenant",
      },
    }));

    expect(res.status).toBe(204);
    expect(new URL(forwarded!.url).pathname).toBe("/tenants/tenant-42/cas/usage");
    expect(forwarded!.headers.get("X-Internal-Token")).toBe(CAS_ACCESS_KEY);
    expect(forwarded!.headers.get("X-Tenant-Id")).toBe("tenant-42");
    expect(forwarded!.headers.get("X-User-Id")).toBeNull();
    expect(forwarded!.headers.get("Authorization")).toBeNull();
    expect(forwarded!.headers.get("Cookie")).toBeNull();
  });

  it("reconciles an ambiguous idempotent create against the original session", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    let upstreamCalls = 0;
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => ({
          userId: "authenticated-user",
          tenantId: "tenant-1",
          canManageTenant: true,
        }),
      },
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "http://doc.invalid",
        accessKey: DOC_ACCESS_KEY,
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
      directory,
      isGatewayExposedCasRoute: () => false,
      generateId: (() => {
        const ids = ["public-doc", "session-1", "discarded-doc", "discarded-session"];
        return () => ids.shift()!;
      })(),
      now: () => 100,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      upstreamCalls += 1;
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/status")) {
        expect(init?.method).toBe("GET");
        return Response.json({ exists: true, version: 1 });
      }
      return Response.json({ error: "upstream timeout" }, { status: 502 });
    };
    try {
      const first = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/", {
        method: "POST",
        headers: { "Idempotency-Key": "create-once" },
      }));
      expect(first.status).toBe(502);

      const retry = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/", {
        method: "POST",
        headers: { "Idempotency-Key": "create-once" },
      }));
      await expect(retry.json()).resolves.toMatchObject({
        docId: "public-doc",
        state: "ready",
        version: 1,
      });
      expect(retry.status).toBe(200);
      expect(upstreamCalls).toBe(2);
      await expect(directory.get("tenant-1", "public-doc")).resolves.toMatchObject({
        sessionId: "session-1",
        state: "ready",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when no Gateway identity can be resolved", async () => {
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: { resolve: async () => null },
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "http://doc.invalid",
        accessKey: DOC_ACCESS_KEY,
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
    });

    const response = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/"));
    expect(response.status).toBe(401);
  });

  it("rejects an authenticated identity bound to another path tenant", async () => {
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async () => ({
          userId: "authenticated-user",
          tenantId: "tenant-2",
          canManageTenant: false,
        }),
      },
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "http://doc.invalid",
        accessKey: DOC_ACCESS_KEY,
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
    });

    const response = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/"));
    expect(response.status).toBe(403);
  });

  it("rejects legacy user routes before identity resolution", async () => {
    let resolved = false;
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async () => {
          resolved = true;
          return null;
        },
      },
      resolveDocService: async () => null,
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => false,
    });

    const response = await handler(new Request("http://gw/users/u1/docs/markdown/"));
    expect(response.status).toBe(404);
    expect(resolved).toBe(false);
  });

  it("requires tenant administration for CAS usage", async () => {
    let forwarded = false;
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => ({
          userId: "authenticated-user",
          tenantId: "tenant-1",
          canManageTenant: false,
        }),
      },
      resolveDocService: async () => null,
      casFetcher: {
        fetch: async () => {
          forwarded = true;
          return new Response(null, { status: 200 });
        },
      },
      directory: new MemoryGatewayDocumentDirectory(),
      isGatewayExposedCasRoute: () => true,
    });

    const response = await handler(new Request("http://gw/tenants/tenant-1/cas/usage"));
    expect(response.status).toBe(403);
    expect(forwarded).toBe(false);
  });

  it("authorizes clone by source docId and keeps the snapshot hash internal", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve({
      docId: "source-doc",
      tenantId: "tenant-1",
      docType: "markdown",
      serviceId: "markdown-primary",
      sessionId: "source-session",
      idempotencyKey: "source-create",
      requestedDocId: "source-doc",
      now: 1,
    });
    await directory.markReady("tenant-1", "source-doc", 7, 2);

    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => ({
          userId: "authenticated-user",
          tenantId: requestedTenantId,
          canManageTenant: false,
        }),
      },
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "http://doc.internal",
        accessKey: DOC_ACCESS_KEY,
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory,
      isGatewayExposedCasRoute: () => false,
      generateId: () => "target-session",
      now: () => 3,
    });

    const paths: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      paths.push(url.pathname);
      if (url.pathname === "/sessions/source-session/snapshot") {
        return Response.json({ success: true, hash: "a".repeat(64), version: 7 });
      }
      expect(url.pathname).toBe("/sessions/target-session/init-from-hash");
      await expect(new Response(init?.body).json()).resolves.toEqual({
        hash: "a".repeat(64),
        sourceVersion: 7,
      });
      return Response.json({ success: true, version: 1 });
    };
    try {
      const clone = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Doc-Id": "target-doc",
        },
        body: JSON.stringify({ sourceId: "source-doc" }),
      }));
      expect(clone.status).toBe(200);
      await expect(clone.json()).resolves.toMatchObject({
        success: true,
        docId: "target-doc",
        version: 1,
      });
      expect(paths).toEqual([
        "/sessions/source-session/snapshot",
        "/sessions/target-session/init-from-hash",
      ]);

      const crossTenant = await handler(new Request("http://gw/tenants/tenant-2/docs/markdown/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "source-doc" }),
      }));
      expect(crossTenant.status).toBe(404);
      expect(paths).toHaveLength(2);

      const rawHash = await handler(new Request(
        "http://gw/tenants/tenant-1/docs/markdown/raw-target/init_from_hash",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash: "a".repeat(64), sourceVersion: 7 }),
        },
      ));
      expect(rawHash.status).toBe(404);
      expect(paths).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not expose a stored service ID when a document service changes", async () => {
    const directory = new MemoryGatewayDocumentDirectory();
    await directory.reserve({
      docId: "doc-1",
      tenantId: "tenant-1",
      docType: "markdown",
      serviceId: "retired-secret-service",
      sessionId: "session-1",
      idempotencyKey: "create-1",
      requestedDocId: null,
      now: 1,
    });
    await directory.markReady("tenant-1", "doc-1", 1, 2);
    const handler = createGatewayHandler({
      internalAuthMode: "legacy",
      casAccessKey: CAS_ACCESS_KEY,
      identityResolver: {
        resolve: async (_request, requestedTenantId) => ({
          userId: "authenticated-user",
          tenantId: "tenant-1",
          canManageTenant: false,
        }),
      },
      resolveDocService: async () => ({
        serviceId: "markdown-primary",
        url: "http://doc.internal",
        accessKey: DOC_ACCESS_KEY,
      }),
      casFetcher: { fetch: async () => new Response(null, { status: 500 }) },
      directory,
      isGatewayExposedCasRoute: () => false,
    });

    const response = await handler(new Request("http://gw/tenants/tenant-1/docs/markdown/doc-1"));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Document service is unavailable");
    expect(text).not.toContain("retired-secret-service");
  });
});
