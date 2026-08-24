/**
 * `createDocTypeHandler` forwards every request by constructing a fresh
 * `Request` from the incoming one's body stream (`new Request(forwardUrl, {
 * ..., body: request.body })`), at three call sites: the bare `POST
 * /users/{userId}/` create path, editor endpoints, and operator endpoints.
 *
 * That shape needs `duplex: "half"` set explicitly once the body is a real
 * `ReadableStream` — Node's `Request` (undici) throws synchronously
 * otherwise ("RequestInit: duplex option is required when sending a body"),
 * while a body that's already fully buffered (a plain string, as most
 * in-process tests would use) never exercises the check at all. So every
 * test here builds the incoming request with a genuine streaming body, to
 * actually exercise the code path that broke under Node before `duplex:
 * "half"` was added to all three forwarding sites (see task-7 review
 * finding 1) — a passing suite here is what keeps that omission from
 * regressing.
 *
 * These are Node-runtime tests (this package's tests run under `vitest` on
 * Node); Cloudflare-side coverage that `duplex: "half"` doesn't break
 * anything there lives in the e2e/treespec suites (`pnpm test:local`,
 * `tests/treespec`), not here.
 */
import { describe, expect, it } from "vitest";
import { createDocTypeHandler } from "../src/doc-type-handler.js";

interface StubNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

function stubNamespace(onFetch: (req: Request) => Promise<Response>): StubNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: onFetch }),
  };
}

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

const INTERNAL_TOKEN = "test-token";

describe("createDocTypeHandler — streaming body forwarding", () => {
  it("forwards the create path (POST /users/{userId}/) body intact", async () => {
    let received: string | undefined;
    const editor = stubNamespace(async (req) => {
      received = await req.text();
      return Response.json({ success: true, docId: "d1", version: 1 });
    });

    const handler = createDocTypeHandler({
      docType: "markdown",
      internalToken: INTERNAL_TOKEN,
      editor,
      operator: stubNamespace(async () => Response.json({}, { status: 501 })),
    });

    const incoming = new Request("http://gw.local/users/u1/", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "content-type": "text/markdown" },
      body: streamBody("# hello"),
      duplex: "half",
    } as RequestInit);

    const res = await handler(incoming);
    expect(res.status).toBe(200);
    expect(received).toBe("# hello");
  });

  it("forwards an editor endpoint (apply) body intact", async () => {
    let received: string | undefined;
    const editor = stubNamespace(async (req) => {
      received = await req.text();
      return Response.json({ success: true, version: 2 });
    });

    const handler = createDocTypeHandler({
      docType: "markdown",
      internalToken: INTERNAL_TOKEN,
      editor,
      operator: stubNamespace(async () => Response.json({}, { status: 501 })),
    });

    const payload = JSON.stringify({ operations: [], description: "x", baseVersion: 1 });
    const incoming = new Request("http://gw.local/users/u1/doc-1/apply", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "content-type": "application/json" },
      body: streamBody(payload),
      duplex: "half",
    } as RequestInit);

    const res = await handler(incoming);
    expect(res.status).toBe(200);
    expect(received).toBe(payload);
  });

  it("forwards an operator endpoint (run) body intact", async () => {
    let received: string | undefined;
    const operator = stubNamespace(async (req) => {
      received = await req.text();
      return Response.json({ success: true });
    });

    const handler = createDocTypeHandler({
      docType: "markdown",
      internalToken: INTERNAL_TOKEN,
      editor: stubNamespace(async () => Response.json({}, { status: 501 })),
      operator,
    });

    const payload = JSON.stringify({ prompt: "do the thing" });
    const incoming = new Request("http://gw.local/users/u1/doc-1/run", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "content-type": "application/json" },
      body: streamBody(payload),
      duplex: "half",
    } as RequestInit);

    const res = await handler(incoming);
    expect(res.status).toBe(200);
    expect(received).toBe(payload);
  });
});
