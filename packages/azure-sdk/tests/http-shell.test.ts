/**
 * `serve()` round-trip tests. No containers needed — these exercise the
 * Node-http <-> Web Request/Response bridge in isolation, not the storage
 * ports (see `ports.test.ts` / `migrate.test.ts` for those). Runs inside the
 * same `vitest run` as the container-backed suites (this package's
 * `globalSetup` starts Docker regardless of which files run), but nothing in
 * this file talks to Postgres or Blob Storage.
 *
 * The multipart case specifically exercises the "duplex patch" documented in
 * `src/http-shell.ts`: the handler below re-wraps `request.body` into a
 * SECOND `Request` before reading it, the same two-hop shape
 * `createDocTypeHandler` / `createGatewayHandler` use when forwarding a
 * request onward. Without the patch this throws synchronously ("duplex
 * option is required when sending a body") the moment a real doc-type
 * worker tried to forward a create/apply/rollback call.
 *
 * Tests share a fixed port and run sequentially (this package's
 * `vitest.config.ts` sets `fileParallelism: false`, and vitest runs `it`
 * blocks within one file in order by default), each `afterEach` closing the
 * server before the next `it` opens a new one on the same port.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ServeHandle } from "../src/http-shell.js";
import { serve } from "../src/http-shell.js";

const PORT = 18899;
const BASE = `http://127.0.0.1:${PORT}`;

let handle: ServeHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("serve()", () => {
  it("round-trips a GET with query string, method and headers", async () => {
    handle = await serve(
      async (req) => {
        const url = new URL(req.url);
        return Response.json({
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          xTest: req.headers.get("x-test"),
        });
      },
      { port: PORT, host: "127.0.0.1" },
    );

    const res = await fetch(`${BASE}/foo/bar?a=1`, {
      headers: { "X-Test": "hello" },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      method: "GET",
      pathname: "/foo/bar",
      search: "?a=1",
      xTest: "hello",
    });
  });

  it("streams a JSON POST body through to the handler", async () => {
    handle = await serve(
      async (req) => {
        const body = (await req.json()) as { n: number };
        return Response.json({ doubled: body.n * 2 });
      },
      { port: PORT, host: "127.0.0.1" },
    );

    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 21 }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ doubled: 42 });
  });

  it("survives a second Request() wrap of the body without duplex set — the doc-type-handler forwarding shape", async () => {
    handle = await serve(
      async (req) => {
        // Mirrors createDocTypeHandler / createGatewayHandler: build a
        // brand new Request from this one's body, with NO explicit
        // `duplex`. On stock Node this throws; the patch in http-shell.ts
        // is what makes it not throw.
        const forwardUrl = new URL(req.url);
        forwardUrl.pathname = "/_internal/create";
        const forwarded = new Request(forwardUrl.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });

        const formData = await forwarded.formData();
        const file = formData.get("file") as File;
        return Response.json({ name: file.name, type: file.type, text: await file.text() });
      },
      { port: PORT, host: "127.0.0.1" },
    );

    const form = new FormData();
    form.set("file", new Blob(["# hello\ncontent"], { type: "text/markdown" }), "doc.md");

    const res = await fetch(`${BASE}/users/u1/`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      name: "doc.md",
      type: "text/markdown",
      text: "# hello\ncontent",
    });
  });

  it("propagates a non-2xx status and JSON error body unchanged", async () => {
    handle = await serve(async () => Response.json({ error: "nope" }, { status: 404 }), {
      port: PORT,
      host: "127.0.0.1",
    });

    const res = await fetch(`${BASE}/missing`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "nope" });
  });

  it("sends no body for GET even when the client sends none (no duplex crash on the bodyless path)", async () => {
    handle = await serve(
      async (req) => Response.json({ hasBody: req.body !== null }),
      { port: PORT, host: "127.0.0.1" },
    );

    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hasBody: false });
  });

  it("survives a bare fetch(url, { body: request.body }) forward — gateway-handler's forwardToWorker shape", async () => {
    // Two servers: an "upstream" the first one forwards to, exactly the way
    // gateway-handler.ts's forwardToWorker does — `fetch(targetUrl, {
    // method, headers, body: request.body })`, no `new Request()` in
    // between. Without the `fetch` half of the patch this throws the same
    // "duplex option is required" TypeError, which the real gateway would
    // report as a 502 "Document worker unreachable".
    const upstream = await serve(async (req) => {
      const text = await req.text();
      return Response.json({ echoed: text });
    }, { port: PORT + 1, host: "127.0.0.1" });

    handle = await serve(async (req) => {
      return fetch(`http://127.0.0.1:${PORT + 1}/`, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
    }, { port: PORT, host: "127.0.0.1" });

    try {
      const res = await fetch(`${BASE}/`, { method: "POST", body: "pass-through" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ echoed: "pass-through" });
    } finally {
      await upstream.close();
    }
  });
});
