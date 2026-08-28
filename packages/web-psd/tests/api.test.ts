import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchHistory, rollback, runAgent, resetAgent } from "../src/ui/api.js";

const json = (body: unknown) => ({ json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("api", () => {
  it("GETs history and returns its data array", async () => {
    const entries = [{ version: 7, timestamp: "t", description: "d", operations: [] }];
    fetchMock.mockResolvedValue(json({ success: true, data: entries, version: 7 }));
    expect(await fetchHistory("abc")).toEqual(entries);
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/history");
  });

  it("POSTs rollback with the target version and returns the new one", async () => {
    fetchMock.mockResolvedValue(json({ success: true, version: 12 }));
    expect(await rollback("abc", 9)).toBe(12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/docs/psd/abc/rollback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ version: 9 });
  });

  it("POSTs run and returns the agent's reply", async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { response: "done", iterations: 2 } }));
    expect(await runAgent("abc", "把角标挪到右下")).toBe("done");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ instruction: "把角标挪到右下" });
  });

  it("POSTs reset", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await resetAgent("abc");
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/reset");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("throws the server's error message", async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: "no such doc" }));
    await expect(fetchHistory("abc")).rejects.toThrow("no such doc");
  });
});
