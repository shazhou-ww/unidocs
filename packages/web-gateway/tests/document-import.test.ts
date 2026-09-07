import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocument, validateImportFile } from "../src/ui/api.js";
import { accessTokenSession } from "./session-fixture.js";

vi.mock("../src/ui/config.js", () => ({ API_BASE: "https://gateway.test", OAUTH_BASE: "https://gateway.test/oauth" }));
beforeEach(() => { sessionStorage.clear(); accessTokenSession("alice"); });
afterEach(() => vi.unstubAllGlobals());

describe("document file import", () => {
  it.each(["markdown", "psd"])("sends %s multipart data with auth and a stable creation key", async type => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ success: true, docId: "imported", state: "ready", version: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["sample"], type === "markdown" ? "notes.md" : "cover.psd");
    const options = { file, requestId: "same-request" };
    await createDocument("alice", type, options); await createDocument("alice", type, options);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://gateway.test/tenants/alice/docs/${type}/`);
      expect(init.headers.get("Authorization")).toMatch(/^Bearer /);
      expect(init.headers.get("Content-Type")).toBeNull();
      expect(init.headers.get("Idempotency-Key")).toBe("same-request");
      expect(init.body.get("file")).toBe(file);
      expect(init.body.get("format")).toBe(type);
    }
  });

  it("rejects wrong extensions, empty and oversized files before requesting", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(createDocument("alice", "psd", { file: new File(["text"], "note.md"), requestId: "id" })).rejects.toThrow("匹配");
    expect(() => validateImportFile("markdown", new File([], "empty.md"))).toThrow("空文件");
    const large = new File(["data"], "large.psd"); Object.defineProperty(large, "size", { value: 32 * 1024 * 1024 + 1 });
    expect(() => validateImportFile("psd", large)).toThrow("32 MiB");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the old empty-create body unchanged and accepts a pending import", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, docId: "pending", state: "creating" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createDocument("alice", "markdown")).toMatchObject({ state: "creating" });
    expect(fetchMock.mock.calls[0]![1].body).toBe("{}");
  });
});