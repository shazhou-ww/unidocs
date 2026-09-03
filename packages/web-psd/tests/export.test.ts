import { describe, it, expect, vi, beforeEach } from "vitest";

// Same shape as controller.test.ts's mock: DocController never runs under
// jsdom, so this drives `ui/controller.ts`'s export orchestration directly.
let capturedEvents: { onDoc: (doc: unknown, version: number) => void; onStatus: (s: string) => void } | undefined;
const flush = vi.fn(async () => {});

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId: string | null = null;
    constructor(_view: unknown, _stage: unknown, events: typeof capturedEvents) {
      capturedEvents = events;
    }
    requestVisibleTiles = vi.fn();
    stage = { clientWidth: 1000, clientHeight: 800 } as unknown as HTMLElement;
    flush = flush;
    createFrom = vi.fn(async function (this: { docId: string | null }) {
      this.docId = "doc-a";
      capturedEvents?.onDoc({ canvas: { width: 1, height: 1 }, layers: [] }, 3);
    });
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

const fakeFile = (name: string): File =>
  ({ name, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as File;

let clicks: Array<{ href: string; download: string }> = [];
let revoked: string[] = [];
// Never reset: the revoke is scheduled a task later, so a previous test's
// timer can fire during this one. Unique URLs keep the assertions honest.
let urlSeq = 0;

beforeEach(() => {
  vi.resetModules();
  capturedEvents = undefined;
  flush.mockReset();
  flush.mockImplementation(async () => {});
  clicks = [];
  revoked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:fake-${++urlSeq}`,
    revokeObjectURL: (u: string) => { revoked.push(u); },
  }));
});

/** Boots the controller with one open document, the state every export
 *  starts from. */
async function openedEditor() {
  const mod = await import("../src/ui/controller.js");
  const store = await import("../src/ui/store.js");
  mod.initController(document.createElement("canvas"), document.createElement("div"));
  await mod.openFile(fakeFile("summer-sale.psd"));
  return { ...mod, ...store };
}

const okResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
}) as unknown as Response;

describe("exportDoc", () => {
  it("flushes the pending queue BEFORE reading the document back from the server", async () => {
    // `applyLocal` returns before the network, so an export fired right after
    // an edit races the background drain and downloads a document missing
    // that edit. The order of these two calls is the whole fix.
    const order: string[] = [];
    flush.mockImplementation(async () => { order.push("flush"); });
    const fetchMock = vi.fn(async (_url: string) => { order.push("fetch"); return okResponse(); });
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc } = await openedEditor();
    await exportDoc();

    expect(order).toEqual(["flush", "fetch"]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/tenants/u1/docs/psd/doc-a/export");
  });

  it("downloads the bytes under the document's own name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    const { exportDoc } = await openedEditor();
    await exportDoc();

    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe("summer-sale.psd");
    // The object URL is one-shot; leaking it pins the blob for the life of
    // the page.
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked).toContain(clicks[0]!.href);
  });

  it("marks the export busy while it runs and clears it afterwards", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    flush.mockImplementation(async () => { await gate; });
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));

    const { exportDoc, getState } = await openedEditor();
    const running = exportDoc();
    await Promise.resolve();
    expect(getState().exporting).toBe(true);

    release();
    await running;
    expect(getState().exporting).toBe(false);
  });

  it("downloads nothing and reports the failure when the flush cannot complete", async () => {
    // Downloading anyway would hand the user a file missing the very edit
    // that failed to submit — worse than no file at all.
    flush.mockImplementation(async () => { throw new Error("HTTP 500"); });
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc, getState } = await openedEditor();
    await exportDoc();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
    expect(getState().exporting).toBe(false);
    expect(getState().status).toContain("HTTP 500");
  });

  it("reports a failed export request rather than downloading an error page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) }) as unknown as Response));

    const { exportDoc, getState } = await openedEditor();
    await exportDoc();

    expect(clicks).toEqual([]);
    expect(getState().status).toContain("404");
  });

  it("does nothing when no document is open", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/ui/controller.js");
    mod.initController(document.createElement("canvas"), document.createElement("div"));

    await mod.exportDoc();

    expect(flush).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("导出 PNG 时请求带上 format=png,文件名换成 .png", async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc } = await openedEditor();
    await exportDoc("png");

    expect(fetchMock.mock.calls[0]![0]).toBe("/tenants/u1/docs/psd/doc-a/export?format=png");
    expect(clicks[0]!.download).toBe("summer-sale.png");
  });

  // 回归护栏:不带参数、以及显式传 "psd",都必须是今天那个 URL(不带查询串)。
  it("不指定格式时的请求与今天完全一致", async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { exportDoc } = await openedEditor();
    await exportDoc();

    expect(fetchMock.mock.calls[0]![0]).toBe("/tenants/u1/docs/psd/doc-a/export");
    expect(clicks[0]!.download).toBe("summer-sale.psd");
  });
});

describe("exportFileName", () => {
  it("按目标格式换扩展名", async () => {
    const { exportFileName } = await import("../src/ui/controller.js");
    expect(exportFileName("a.psd", "psd")).toBe("a.psd");
    expect(exportFileName("a.psd", "png")).toBe("a.png");
    expect(exportFileName("a.png", "psd")).toBe("a.psd");
    // 没有扩展名的名字直接追加,而不是把最后一段当扩展名切掉。
    expect(exportFileName("summer sale", "png")).toBe("summer sale.png");
  });

  it("没有文档名时回落到按格式命名", async () => {
    const { exportFileName } = await import("../src/ui/controller.js");
    expect(exportFileName(null, "psd")).toBe("export.psd");
    expect(exportFileName(null, "png")).toBe("export.png");
  });
});
