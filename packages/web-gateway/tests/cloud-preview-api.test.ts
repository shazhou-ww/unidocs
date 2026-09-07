import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPsdPreviewTransport, readMarkdownPreview } from "../src/ui/api.js";
import { accessTokenSession } from "./session-fixture.js";

vi.mock("../src/ui/config.js", () => ({ API_BASE: "https://gateway.test", OAUTH_BASE: "https://gateway.test/oauth", CLIENT_NAME: "test", REDIRECT_URI: "https://gateway.test/ui/callback" }));
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); accessTokenSession("alice"); });
afterEach(() => vi.unstubAllGlobals());

describe("cloud read-only previews", () => {
  it("queries Markdown content with authentication and the response version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, data: "# Cloud", version: 8 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(await readMarkdownPreview("alice", "doc/id", signal)).toEqual({ content: "# Cloud", version: 8 });
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.test/tenants/alice/docs/markdown/doc%2Fid/query");
    expect(request.body).toBe(JSON.stringify({ kind: "getContent" }));
    expect(request.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(request.cache).toBe("no-store");
    expect(request.signal).toBe(signal);
  });

  it("rejects malformed content/version and propagates access denial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ success: true, data: "text", version: 0 }))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 })));
    await expect(readMarkdownPreview("alice", "doc", new AbortController().signal)).rejects.toThrow("版本格式无效");
    await expect(readMarkdownPreview("alice", "doc", new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  });

  it("does not send requests using a different tenant's active session", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(readMarkdownPreview("bob", "doc", new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows only current-document IR and tenant pixel GETs", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1]), { headers: { "X-Doc-Version": "4" } })));
    vi.stubGlobal("fetch", fetchMock);
    const transport = createPsdPreviewTransport("alice", "doc", new AbortController().signal);
    await transport.fetchImpl(`${transport.apiBaseUrl}/docs/psd/doc/ir`);
    await transport.fetchImpl(`${transport.apiBaseUrl}/cas/nodes/${"a".repeat(64)}/content`);
    for (const target of ["https://untrusted.test/ir", `${transport.apiBaseUrl}/docs/psd/other/ir`, `${transport.apiBaseUrl}/docs/psd/doc/apply`, `${transport.apiBaseUrl}/cas/nodes/../secret/content`]) {
      await expect(transport.fetchImpl(target)).rejects.toMatchObject({ status: 403 });
    }
    await expect(transport.fetchImpl(`${transport.apiBaseUrl}/docs/psd/doc/ir`, { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unversioned PSD responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bytes")));
    const transport = createPsdPreviewTransport("alice", "doc", new AbortController().signal);
    await expect(transport.fetchImpl(`${transport.apiBaseUrl}/docs/psd/doc/ir`)).rejects.toThrow("有效版本号");
  });
});