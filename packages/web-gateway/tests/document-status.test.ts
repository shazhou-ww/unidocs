import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { documentStatus } from "../src/ui/api.js";
import { accessTokenSession } from "./session-fixture.js";
vi.mock("../src/ui/config.js", () => ({ API_BASE: "https://gateway.test" }));
beforeEach(() => { sessionStorage.clear(); accessTokenSession("alice"); });
afterEach(() => vi.unstubAllGlobals());
it("unwraps and validates the status envelope using an authenticated GET", async () => {
  const data = { doc_id: "doc/id", doc_type: "psd", state: "ready", version: 2 };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, data })); vi.stubGlobal("fetch", fetchMock);
  const signal = new AbortController().signal;
  expect(await documentStatus("alice", "psd", "doc/id", signal)).toEqual(data);
  expect(fetchMock.mock.calls[0]![0]).toBe("https://gateway.test/tenants/alice/docs/psd/doc%2Fid");
  const request = fetchMock.mock.calls[0]![1]; expect(request.cache).toBe("no-store"); expect(request.signal).toBe(signal);
  expect(request.headers.get("Authorization")).toMatch(/^Bearer /); expect(request.body).toBeUndefined();
});
it.each([{ doc_id: "other", doc_type: "psd", state: "ready", version: 1 }, { doc_id: "doc", doc_type: "psd", state: "ready", version: null }, { doc_id: "doc", doc_type: "psd", state: "unknown", version: 1 }])("rejects a mismatched or malformed status", async data => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, data })));
  await expect(documentStatus("alice", "psd", "doc")).rejects.toThrow("响应无效");
});