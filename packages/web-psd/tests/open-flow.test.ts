import { describe, it, expect, vi, beforeEach } from "vitest";

// 和 controller.test.ts 同一套替身:DocController 在 jsdom 下跑不起来(要开
// Worker、要连网关),所以直接驱动 ui/controller.ts 的编排。这里额外捕获
// onOpenPhase / onOpenFailed 两个新回调。
let capturedEvents: {
  onDoc: (doc: unknown, version: number) => void;
  onStatus: (s: string) => void;
  onOpenPhase: (p: string) => void;
  onOpenFailed: (e: Error) => void;
} | undefined;

/** 每个用例自己决定 createFrom 期间做什么:推进阶段、卡住、或者报失败。 */
let createFromImpl: (self: { docId: string | null }, label: string) => Promise<void> =
  async () => {};

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId: string | null = null;
    constructor(_view: unknown, _stage: unknown, events: typeof capturedEvents) {
      capturedEvents = events;
    }
    requestVisibleTiles = vi.fn();
    stage = { clientWidth: 1000, clientHeight: 800 } as unknown as HTMLElement;
    createFrom = vi.fn(async function (this: { docId: string | null }, _b: Uint8Array, label: string) {
      await createFromImpl(this, label);
    });
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

const fakeFile = (name: string): File =>
  ({ name, arrayBuffer: async () => new ArrayBuffer(2048) }) as unknown as File;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
  capturedEvents = undefined;
  createFromImpl = async () => {};
});

async function booted() {
  const mod = await import("../src/ui/controller.js");
  const store = await import("../src/ui/store.js");
  mod.initController(document.createElement("canvas"), document.createElement("div"));
  return { ...mod, ...store };
}

describe("open flow: opening state", () => {
  it("seeds the overlay with the file's name and size before anything is sent", async () => {
    const seen: unknown[] = [];
    const { openFile, getState } = await booted();
    createFromImpl = async () => { seen.push(getState().opening); };

    await openFile(fakeFile("summer-sale.psd"));

    expect(seen[0]).toEqual({ phase: "upload", name: "summer-sale.psd", bytes: 2048 });
  });

  it("advances the phase as DocController reports it", async () => {
    const phases: string[] = [];
    const { openFile, getState } = await booted();
    createFromImpl = async (self) => {
      for (const p of ["parse", "load", "render"]) {
        capturedEvents!.onOpenPhase(p);
        phases.push(getState().opening!.phase);
      }
      self.docId = "doc-a";
      capturedEvents!.onDoc({ canvas: { width: 1, height: 1 }, layers: [] }, 3);
    };

    await openFile(fakeFile("a.psd"));

    expect(phases).toEqual(["parse", "load", "render"]);
    // 阶段推进不能把文件名冲掉——它和阶段在同一个字段里。
    expect(getState().docName).toBe("a.psd");
  });

  it("clears the overlay once the open settles", async () => {
    const { openFile, getState } = await booted();
    createFromImpl = async (self) => {
      self.docId = "doc-a";
      capturedEvents!.onDoc({ canvas: { width: 1, height: 1 }, layers: [] }, 3);
    };

    await openFile(fakeFile("a.psd"));

    expect(getState().opening).toBeNull();
  });

  // DocController 按设计永不 reject(见 ui/controller.ts 里 `before` 比较那段
  // 注释),所以失败要靠事件报出来——但遮罩的清除不能依赖那个事件到达。
  it("clears the overlay and reports the failure in the transcript", async () => {
    const { openFile, getState } = await booted();
    createFromImpl = async () => {
      capturedEvents!.onOpenFailed(new Error("HTTP 502: 响应不是 JSON"));
    };

    await openFile(fakeFile("a.psd"));

    expect(getState().opening).toBeNull();
    expect(getState().status).toContain("HTTP 502");
    expect(getState().chat.at(-1)).toMatchObject({ role: "err" });
  });

  it("clears the overlay even when nothing reports anything at all", async () => {
    // finally 而不是「收到落地事件才清」:少一个事件就把遮罩永久留在屏幕上,
    // 而那正是用户完全无法自救的状态。
    const { openFile, getState } = await booted();
    createFromImpl = async () => {};

    await openFile(fakeFile("a.psd"));

    expect(getState().opening).toBeNull();
  });
});
