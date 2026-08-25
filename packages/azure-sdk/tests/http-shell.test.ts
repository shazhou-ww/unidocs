/**
 * `serve()` round-trip tests. No containers needed — these exercise the
 * Node-http <-> Web Request/Response bridge in isolation, not the storage
 * ports (see `ports.test.ts` / `migrate.test.ts` for those). Runs inside the
 * same `vitest run` as the container-backed suites (this package's
 * `globalSetup` starts Docker regardless of which files run), but nothing in
 * this file talks to Postgres or Blob Storage.
 *
 * Streaming-body forwarding through server-core's `createDocTypeHandler` /
 * `createGatewayHandler` (the `duplex: "half"` requirement under Node) is
 * covered directly against those modules in
 * `packages/doctype-server-common/tests/doc-type-handler.test.ts` and
 * `gateway-handler.test.ts` — that's the layer that actually needed the fix,
 * so the regression tests live there rather than here.
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

  it("streams a multipart/form-data POST body through to the handler intact", async () => {
    handle = await serve(async (req) => {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      return Response.json({ name: file.name, type: file.type, text: await file.text() });
    }, { port: PORT, host: "127.0.0.1" });

    const form = new FormData();
    form.set("file", new Blob(["# hello\ncontent"], { type: "text/markdown" }), "doc.md");

    const res = await fetch(`${BASE}/echo`, {
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

  it("sends no body for GET even when the client sends none", async () => {
    handle = await serve(
      async (req) => Response.json({ hasBody: req.body !== null }),
      { port: PORT, host: "127.0.0.1" },
    );

    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hasBody: false });
  });
});
