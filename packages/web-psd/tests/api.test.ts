import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSBlob, encodeSValue } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import { fetchHistory, rollback, runAgent, resetAgent, withTarget } from "../src/ui/api.js";

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
/** History speaks SValue, not JSON — a delta's ops can carry CAS blob refs. */
const svalue = (body: unknown) => ({
  ok: true, status: 200,
  arrayBuffer: async () => Uint8Array.from(encodeSValue(body as never)).buffer,
  json: async () => { throw new Error("fetchHistory must not read history as JSON"); },
});
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
  it("GETs history as SValue and returns its data array", async () => {
    const entries = [{ version: 7, timestamp: "t", description: "d", operations: [] }];
    fetchMock.mockResolvedValue(svalue({ success: true, data: entries, version: 7 }));
    expect(await fetchHistory("abc")).toEqual(entries);
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/history");
    // 必须显式要 SValue：带引用的响应对 Accept: */* 会被编辑器 406 掉。
    expect(fetchMock.mock.calls[0][1].headers.accept).toBe(SValueContentType);
  });

  it("history 里带 CAS 引用的 op 能原样取回 —— 这正是 JSON 表达不了的东西", async () => {
    // editPixels 产出的 generative_fill 会把结果层的像素以 SBlob 引用记进
    // delta。引用没有 JSON 投影（svalue-codec 的 toJsonValue 直接抛），所以
    // 这条路径以前对浏览器是 406。不能靠"UI 反正不读 operations"绕过去 ——
    // 今天不读不代表以后不读。
    const blob = createSBlob("a".repeat(64));
    const entries = [{
      version: 8, timestamp: "t", description: "editPixels(portrait)",
      operations: [{ kind: "generative_fill", payload: { layer: { pixels: { width: 4, height: 4, hash: "a".repeat(64), blob } } } }],
    }];
    fetchMock.mockResolvedValue(svalue({ success: true, data: entries, version: 8 }));
    const got = await fetchHistory("abc") as any[];
    const pixels = got[0].operations[0].payload.layer.pixels;
    expect(pixels.hash).toBe("a".repeat(64));
    expect(pixels.blob.hash).toBe("a".repeat(64));
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

  it("splices the target into the instruction it POSTs", async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { response: "done" } }));
    await runAgent("abc", "换成晚霞", { bounds: [1, 2, 3, 4], layers: [{ id: "L3", name: "天空" }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      instruction: '<<selection bounds=[1,2,3,4] layers=[{"id":"L3","name":"天空"}]>>\n换成晚霞',
    });
  });

  it("POSTs reset", async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await resetAgent("abc");
    expect(fetchMock.mock.calls[0][0]).toContain("/docs/psd/abc/reset");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("throws the server's error message", async () => {
    // history 走 SValue，所以 success:false 的信封也是 SValue 编码的
    fetchMock.mockResolvedValue(svalue({ success: false, error: "no such doc" }));
    await expect(fetchHistory("abc")).rejects.toThrow("no such doc");
  });
});

// Before this gate, `readJson` looked only at the BODY. A 404/500 whose body
// happened to parse as JSON flowed straight through as a success: fetchHistory
// turned it into `[]` (indistinguishable from "this session changed nothing")
// and rollback returned `undefined` while the caller went on to reconcile, so
// a failed rollback looked exactly like a successful one that changed nothing.
describe("withTarget", () => {
  it("returns the instruction untouched when there is no target", () => {
    expect(withTarget("把角标挪到右下", null)).toBe("把角标挪到右下");
  });

  // The delimiter has to survive a user typing brackets of their own, and it
  // appears ONCE, at the front — the operator is a ReAct loop with
  // conversation memory (api.ts's resetAgent), so a marker sprinkled mid-text
  // would give it several bounds with no way to tell which is current.
  it("prefixes one delimited marker carrying bounds and layer id+name", () => {
    expect(withTarget("把框中的天空换成晚霞", {
      bounds: [120, 340, 560, 900],
      layers: [{ id: "L1", name: "图层 3" }, { id: "L2", name: "天空" }],
    })).toBe('<<selection bounds=[120,340,560,900] layers=[{"id":"L1","name":"图层 3"},{"id":"L2","name":"天空"}]>>\n把框中的天空换成晚霞');
  });

  it("omits the layer list entirely when no layer is selected", () => {
    expect(withTarget("重画这块", { bounds: [0, 0, 10, 10], layers: [] }))
      .toBe("<<selection bounds=[0,0,10,10]>>\n重画这块");
  });

  // 图层选择没有框，只有图层。以前这种情况根本不发标记，agent 收到的是一句
  // 指着它看不见的东西的话（"选中的图层中，网址改成 X"），只能靠 getLayers /
  // getPreview 一层层猜 —— 实测烧满 25 轮、182 秒。
  it("carries a layer selection with no bounds — a layer has bounds of its own", () => {
    expect(withTarget("网址改成 www.unidocs.com", { layers: [{ id: "L7", name: "网址" }] }))
      .toBe('<<selection layers=[{"id":"L7","name":"网址"}]>>\n网址改成 www.unidocs.com');
  });

  it("两半都空就不发标记 —— 一个空壳会让 agent 以为用户指了什么", () => {
    expect(withTarget("随便改改", { layers: [] })).toBe("随便改改");
  });
});

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
