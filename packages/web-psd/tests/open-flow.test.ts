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

// `size` matters now, not just `arrayBuffer()`'s length: #4's fix seeds
// `opening` from the `File` itself (name + size) BEFORE reading it, so a
// fake missing `size` would silently seed `bytes: undefined`.
const fakeFile = (name: string): File =>
  ({ name, size: 2048, arrayBuffer: async () => new ArrayBuffer(2048) }) as unknown as File;

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

  // #1: POST 成功、`initRender` 才炸——`before` !== 新 docId 时,wrapper 采纳
  // 新 docId/label 并清空 chat,但这条 open 自己刚通过 onOpenFailed 写进去的
  // err 气泡不能被这次清空一并抹掉,否则用户只剩右上角那行已经被这个项目
  // 明确弃用的小字。
  it("keeps the open's own error bubble when the POST succeeds but rendering then throws (#1)", async () => {
    const { openFile, getState } = await booted();
    createFromImpl = async (self) => {
      // 模拟 doc-controller.ts 的真实时序:docIdField 在 initRender 之前就
      // 已经赋值(见 createFrom -> initRender),render 炸了以后走
      // onOpenFailed,而不是 reject。
      self.docId = "doc-new";
      capturedEvents!.onOpenFailed(new Error("渲染失败:画布初始化异常"));
    };

    await openFile(fakeFile("big.psd"));

    // docId/label 仍然被采纳——服务端确实建好了新文档。
    expect(getState().docId).toBe("doc-new");
    expect(getState().docName).toBe("big.psd");
    // 但错误气泡必须活下来,而不是被「新文档,清空会话」的逻辑一并冲掉。
    expect(getState().chat).toHaveLength(1);
    expect(getState().chat[0]).toMatchObject({ role: "err" });
    expect(getState().chat[0].text).toContain("渲染失败");
  });

  // #4: 大文件读进内存本身要好几秒,这段时间也要有遮罩、也要挡住第二次
  // 「打开」。种子必须在 `await file.arrayBuffer()` resolve 之前就落地,而
  // 不是等它读完、拿到字节数组以后才种。
  it("seeds `opening` before file.arrayBuffer() resolves (#4)", async () => {
    const { openFile, getState } = await booted();
    let resolveBuf!: (buf: ArrayBuffer) => void;
    const pending = new Promise<ArrayBuffer>((resolve) => { resolveBuf = resolve; });
    const slowFile = { name: "huge.psd", size: 123_456_789, arrayBuffer: () => pending } as unknown as File;

    const openPromise = openFile(slowFile);
    // `openFile` 到第一个 `await` 为止是同步执行的(见 JS 语义),所以这里
    // 不需要等一个微任务——调用一返回,种子应该已经在 store 里了。
    expect(getState().opening).toEqual({ phase: "upload", name: "huge.psd", bytes: 123_456_789 });

    resolveBuf(new ArrayBuffer(123_456_789));
    await openPromise;
    expect(getState().opening).toBeNull();
  });
});
