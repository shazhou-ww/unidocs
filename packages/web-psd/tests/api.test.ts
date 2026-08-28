import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchHistory, rollback, runAgent, resetAgent } from "../src/ui/api.js";

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
/** A transport failure: HTTP status set, body is whatever the gateway emitted. */
const httpError = (status: number, text: string) => ({
  ok: false, status,
  text: async () => text,
  json: async () => { throw new Error("readJson must not reach json() on a failed response"); },
});
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

// Before this gate, `readJson` looked only at the BODY. A 404/500 whose body
// happened to parse as JSON flowed straight through as a success: fetchHistory
// turned it into `[]` (indistinguishable from "this session changed nothing")
// and rollback returned `undefined` while the caller went on to reconcile, so
// a failed rollback looked exactly like a successful one that changed nothing.
describe("api: non-2xx responses", () => {
  it("throws with the status and body instead of parsing the payload", async () => {
    fetchMock.mockResolvedValue(httpError(404, "no such doc"));
    await expect(fetchHistory("abc")).rejects.toThrow("HTTP 404: no such doc");
  });

  it("never turns a failed history request into an empty history", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "", json: async () => ({ data: [] }) });
    await expect(fetchHistory("abc")).rejects.toThrow("HTTP 500");
  });

  it("throws on a failed rollback rather than returning an undefined version", async () => {
    fetchMock.mockResolvedValue(httpError(409, "version conflict"));
    await expect(rollback("abc", 9)).rejects.toThrow("HTTP 409: version conflict");
  });

  it("throws on a failed run and on a failed reset", async () => {
    fetchMock.mockResolvedValue(httpError(500, "operator exploded"));
    await expect(runAgent("abc", "x")).rejects.toThrow("HTTP 500: operator exploded");
    await expect(resetAgent("abc")).rejects.toThrow("HTTP 500: operator exploded");
  });

  it("still throws when the error body is empty or unreadable", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "", json: async () => ({}) });
    await expect(fetchHistory("abc")).rejects.toThrow("HTTP 502");
  });
});
