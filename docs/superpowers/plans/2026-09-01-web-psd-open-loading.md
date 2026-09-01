# web-psd 打开文件加载反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「打开 PSD」的反馈从右上角一行小字，换成盖在画布列上的四阶段遮罩，并在加载期间锁住会打到旧文档的所有交互。

**Architecture:** store 新增一个 `opening: OpenProgress | null` 字段，作为遮罩和四处禁用唯一的共同真相。`DocController` 只报告它知道的两件事（阶段变了 `onOpenPhase`、失败了 `onOpenFailed`）；`opening` 的写入与清除由 `ui/controller.ts` 的 `createFrom` wrapper 用 try/finally 拥有。为了把「还在上传」和「服务器在解析」分开，`createFrom` 里那一处 POST 从 `fetch` 换成 `XMLHttpRequest`，只为听 `upload.onload` 一个事件。

**Tech Stack:** TypeScript + React 19 + Vite 7 + vitest 3 + @testing-library/react（jsdom 环境）。包：`packages/web-psd`。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-09-01-web-psd-open-loading-design.md`。有冲突以 spec 为准。
- 测试：`pnpm --filter @unidocs/web-psd test`；单文件 `pnpm --filter @unidocs/web-psd exec vitest run tests/<file>`。
- 类型：`pnpm --filter @unidocs/web-psd typecheck`。
- 所有用户可见文案用中文，和现有 UI 一致（「打开」「导出」「还没有打开文档」）。
- 颜色只用 `src/ui/styles.css` 顶部 `:root` 里已有的 token，不新增颜色值。
- **不改** `doc-controller.ts` 里 `initRender` 中 `onDoc` 相对于渲染的先后顺序（doc-controller.ts:102-117 的注释解释了原因）。
- **不引入 import 环**：`tests/no-import-cycles.test.ts` 会因此变红。新组件只 import `../store.js`，不碰 `controller.ts`。
- 每个任务结束时 `pnpm --filter @unidocs/web-psd test` 必须全绿，不只是本任务新增的那几条。

---

### Task 1: `opening` 状态与遮罩组件

**Files:**
- Modify: `packages/web-psd/src/ui/store.ts:7`（类型区）、`:28-58`（`UiState`）、`:60-66`（`INITIAL`）
- Create: `packages/web-psd/src/ui/panels/open-overlay.tsx`
- Modify: `packages/web-psd/src/ui/app.tsx:22-27`（挂进 `.col-canvas`）
- Modify: `packages/web-psd/src/ui/styles.css:108-115`（`.col-canvas` 加 `position: relative`）、文件末尾（新样式）
- Test: `packages/web-psd/tests/open-overlay.test.tsx`（新建）
- Test: `packages/web-psd/tests/app-shell.test.tsx`（加一条挂载断言）

**Interfaces:**
- Consumes: `useUiState`、`setState`（`src/ui/store.ts` 已有）
- Produces:
  - `type OpenPhase = "upload" | "parse" | "load" | "render"`（从 `src/ui/store.ts` 导出）
  - `interface OpenProgress { phase: OpenPhase; name: string; bytes: number }`（从 `src/ui/store.ts` 导出）
  - `UiState.opening: OpenProgress | null`
  - `function OpenOverlay(): JSX.Element | null`（从 `src/ui/panels/open-overlay.tsx` 导出）
  - `function formatBytes(bytes: number): string`（同文件导出，仅供测试与本组件用）

- [ ] **Step 1: 写失败的测试**

新建 `packages/web-psd/tests/open-overlay.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { OpenOverlay, formatBytes } from "../src/ui/panels/open-overlay.js";
import { setState } from "../src/ui/store.js";

describe("formatBytes", () => {
  it("switches unit at each 1024 boundary", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(44_150_000)).toBe("42.1 MB");
  });
});

describe("OpenOverlay", () => {
  it("renders nothing when no open is in flight", () => {
    const { container } = render(<OpenOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the file being opened and how big it is", () => {
    setState({ opening: { phase: "upload", name: "summer-sale.psd", bytes: 44_150_000 } });
    render(<OpenOverlay />);
    expect(screen.getByText("summer-sale.psd · 42.1 MB")).toBeInTheDocument();
  });

  // 阶段名本身就是进度：走过的、正在跑的、还没到的必须一眼分得开，
  // 否则四个点和一个转圈没有区别。
  it("splits the steps into done / now / todo around the current phase", () => {
    setState({ opening: { phase: "load", name: "a.psd", bytes: 1024 } });
    render(<OpenOverlay />);
    expect(screen.getByText("上传").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("解析").closest("li")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("载入").closest("li")).toHaveAttribute("data-state", "now");
    expect(screen.getByText("渲染").closest("li")).toHaveAttribute("data-state", "todo");
    expect(screen.getByText("正在载入…")).toBeInTheDocument();
  });

  it("follows the phase as it advances", () => {
    setState({ opening: { phase: "upload", name: "a.psd", bytes: 1024 } });
    render(<OpenOverlay />);
    expect(screen.getByText("正在上传…")).toBeInTheDocument();
    act(() => { setState({ opening: { phase: "render", name: "a.psd", bytes: 1024 } }); });
    expect(screen.getByText("正在渲染…")).toBeInTheDocument();
    expect(screen.getByText("载入").closest("li")).toHaveAttribute("data-state", "done");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-overlay.test.tsx`
Expected: FAIL —— `Failed to resolve import "../src/ui/panels/open-overlay.js"`

- [ ] **Step 3: 加 store 字段**

`src/ui/store.ts`，在 `export type ToolId` 那一行下面加：

```ts
export type OpenPhase = "upload" | "parse" | "load" | "render";

export interface OpenProgress {
  phase: OpenPhase;
  /** 文件名与字节数,只供遮罩显示。 */
  name: string;
  bytes: number;
}
```

在 `UiState` 里（`pickedColor` 那一行下面）加：

```ts
  /** 一次「打开文件」正在进行中,值是当前阶段;null = 没有。遮罩和加载期间
   *  四处禁用读的都是这一个字段——它们要的是同一个 null 判断,拆成
   *  「阶段」+「文件信息」两个字段就多出一种表达得出来却不该存在的状态。 */
  opening: OpenProgress | null;
```

在 `INITIAL` 里加 `opening: null,`。

- [ ] **Step 4: 写遮罩组件**

新建 `src/ui/panels/open-overlay.tsx`：

```tsx
import { useUiState, type OpenPhase } from "../store.js";

/**
 * 打开一个文件时盖住画布列的加载遮罩。
 *
 * 阶段制,不显示百分比:四段里「服务端解析」和「worker 解码」根本无从测量,
 * 凑出来的百分比只能靠估算填补,结果就是经典的「卡在 87%」。阶段名本身已经
 * 回答了「现在在干什么、还剩几步」。
 *
 * 只读 `store`,不 import `controller.js`——`tests/no-import-cycles.test.ts`
 * 盯着这件事,而画布列里已经有组件走 controller 了。
 */
const PHASES: { id: OpenPhase; step: string; running: string }[] = [
  { id: "upload", step: "上传", running: "正在上传…" },
  { id: "parse", step: "解析", running: "正在解析…" },
  { id: "load", step: "载入", running: "正在载入…" },
  { id: "render", step: "渲染", running: "正在渲染…" },
];

export function OpenOverlay() {
  const { opening } = useUiState();
  if (!opening) return null;
  const at = PHASES.findIndex((p) => p.id === opening.phase);
  return (
    // role="status" + aria-live:阶段推进对读屏用户也要能听见,而遮罩本身
    // 没有任何可聚焦的东西,不该抢焦点。
    <div className="open-overlay" role="status" aria-live="polite">
      <div className="open-card">
        <ol className="open-steps">
          {PHASES.map((p, i) => (
            <li key={p.id} data-state={i < at ? "done" : i === at ? "now" : "todo"}>
              <i />
              <span>{p.step}</span>
            </li>
          ))}
        </ol>
        <p className="open-file mono">{`${opening.name} · ${formatBytes(opening.bytes)}`}</p>
        <p className="open-phase">{PHASES[at].running}</p>
      </div>
    </div>
  );
}

/** 字节数按 B / KB / MB 显示。一位小数:42.1 MB 和 42 MB 在等一个大文件的时候
 *  是两种不同的信息量。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
```

- [ ] **Step 5: 加样式**

`src/ui/styles.css`，`.col-canvas` 规则里加一行 `position: relative;`（遮罩的定位祖先）：

```css
.col-canvas {
  order: 2;
  flex: 1;
  min-width: var(--canvas-min);
  display: flex;
  flex-direction: column;
  background: var(--canvas-bg);
  /* 打开文件的遮罩(.open-overlay)的定位祖先。 */
  position: relative;
}
```

文件末尾追加：

```css
/* 打开文件时盖住整个画布列(stage + context bar)。
   挂在 .col-canvas 而不是 .stage:.stage 是 overflow:auto,换文件时底下可能
   还是上一个文档的滚动内容,inset:0 的绝对定位子元素会跟着内容滚走。
   背景用带 alpha 的颜色而不是元素 opacity——后者会把卡片上的文字一起淡掉。 */
.open-overlay {
  position: absolute; inset: 0; z-index: 20;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--canvas-bg) 92%, transparent);
}
.open-card { display: grid; justify-items: center; gap: 10px; }
.open-steps { display: flex; align-items: center; list-style: none; margin: 0; padding: 0; }
.open-steps li {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--fg-dim);
}
.open-steps li + li::before {
  content: ""; width: 26px; height: 1px; margin: 0 8px; background: var(--border-strong);
}
.open-steps li i { width: 7px; height: 7px; border-radius: 50%; border: 1px solid currentColor; }
.open-steps li[data-state="done"] { color: var(--accent-ink); }
.open-steps li[data-state="done"] i { background: currentColor; }
.open-steps li[data-state="now"] { color: var(--accent); }
/* `blip` 早就定义在文件顶部却一直没人用,正好是这里要的脉冲。 */
.open-steps li[data-state="now"] i { background: currentColor; animation: blip 1s ease-in-out infinite; }
.open-file { margin: 0; font-size: 12px; color: var(--fg); }
.open-phase { margin: 0; font-size: 11.5px; color: var(--fg-3); }
```

- [ ] **Step 6: 挂进 app.tsx**

`src/ui/app.tsx`：顶部加 `import { OpenOverlay } from "./panels/open-overlay.js";`，并把 `.col-canvas` 改成

```tsx
        <section className="col-canvas">
          <CanvasStage />
          <ContextBar />
          <OpenOverlay />
        </section>
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-overlay.test.tsx`
Expected: PASS，5 条全过

- [ ] **Step 8: 补一条挂载断言**

`tests/app-shell.test.tsx` 的 `describe("App shell")` 里加：

```tsx
  it("mounts the open overlay inside the canvas column, not the stage", () => {
    // .stage 会滚动,遮罩必须挂在不滚动的列上,否则换一个大文件时它会跟着
    // 上一个文档的内容滚出视野。
    setState({ opening: { phase: "upload", name: "a.psd", bytes: 1024 } });
    const { container } = render(<App />);
    const overlay = container.querySelector(".open-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay!.parentElement).toHaveClass("col-canvas");
  });
```

同时给该文件顶部加 `import { setState } from "../src/ui/store.js";`。

- [ ] **Step 9: 跑整包测试**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: 全绿（含既有 33 个测试文件）

- [ ] **Step 10: 提交**

```bash
git add packages/web-psd/src/ui/store.ts packages/web-psd/src/ui/panels/open-overlay.tsx \
        packages/web-psd/src/ui/app.tsx packages/web-psd/src/ui/styles.css \
        packages/web-psd/tests/open-overlay.test.tsx packages/web-psd/tests/app-shell.test.tsx
git commit -m "feat(web-psd): 打开文件的四阶段遮罩与 opening 状态"
```

---

### Task 2: `postForm` —— 把「上传」和「解析」分开

**Files:**
- Modify: `packages/web-psd/src/doc-controller.ts`（文件末尾加 helper；`createFrom` 在 Task 3 才改用它）
- Test: `packages/web-psd/tests/post-form.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `export function postForm(url: string, fd: FormData, onUploaded: () => void): Promise<{ success?: boolean; docId?: string; error?: string }>`（从 `src/doc-controller.ts` 导出）

- [ ] **Step 1: 写失败的测试**

新建 `packages/web-psd/tests/post-form.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { postForm } from "../src/doc-controller.js";

/** 最小的 XMLHttpRequest 替身。jsdom 自带的那个会真的去发请求,而这里要考的
 *  恰恰是几个回调的触发顺序,所以整个换掉。 */
class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onload: (() => void) | null } = { onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = "";
  status = 0;
  opened: [string, string] | null = null;
  sent: unknown = null;
  constructor() { FakeXHR.last = this; }
  open(method: string, url: string): void { this.opened = [method, url]; }
  send(body: unknown): void { this.sent = body; }
}

beforeEach(() => {
  FakeXHR.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

describe("postForm", () => {
  it("POSTs the form to the given url", () => {
    const fd = new FormData();
    void postForm("/tenants/u1/docs/psd/", fd, () => {});
    expect(FakeXHR.last!.opened).toEqual(["POST", "/tenants/u1/docs/psd/"]);
    expect(FakeXHR.last!.sent).toBe(fd);
  });

  // 这是整个 helper 存在的理由:最后一个字节离开浏览器,和服务器解析完 PSD
  // 回话,是两个时刻。fetch 下它们是一个不透明的 await,而对一个大 PSD 这
  // 恰好是最长、且时长差别最大的两段。
  it("signals the upload finishing separately from the response arriving", async () => {
    const seen: string[] = [];
    const xhr = (): FakeXHR => FakeXHR.last!;
    const p = postForm("/u", new FormData(), () => seen.push("uploaded"));

    xhr().upload.onload!();
    expect(seen).toEqual(["uploaded"]);

    xhr().status = 200;
    xhr().responseText = JSON.stringify({ success: true, docId: "doc-a" });
    xhr().onload!();
    await expect(p).resolves.toEqual({ success: true, docId: "doc-a" });
  });

  it("resolves the parsed body without judging it — success is the caller's check", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.status = 200;
    FakeXHR.last!.responseText = JSON.stringify({ success: false, error: "not a psd" });
    FakeXHR.last!.onload!();
    await expect(p).resolves.toEqual({ success: false, error: "not a psd" });
  });

  it("rejects on a network error", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.onerror!();
    await expect(p).rejects.toThrow("网络错误");
  });

  it("rejects on an aborted request", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.onabort!();
    await expect(p).rejects.toThrow("请求已中断");
  });

  // 网关 5xx 时返回的是一个 HTML 错误页,JSON.parse 会抛。不接住的话它会以
  // 一个语法错误的形式冒到用户面前,而真正有用的是那个状态码。
  it("rejects with the status code when the body is not JSON", async () => {
    const p = postForm("/u", new FormData(), () => {});
    FakeXHR.last!.status = 502;
    FakeXHR.last!.responseText = "<html>Bad Gateway</html>";
    FakeXHR.last!.onload!();
    await expect(p).rejects.toThrow("HTTP 502");
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/post-form.test.ts`
Expected: FAIL —— `postForm is not a function` / 导出不存在

- [ ] **Step 3: 实现 helper**

`src/doc-controller.ts` 末尾（`debounce` 下面）加：

```ts
/**
 * POST 一个 FormData,resolve 解析后的 JSON body。
 *
 * 用 XHR 而不是 fetch 只为一件事:`upload.onload` 标出「最后一个字节离开浏览器」
 * 的时刻,把「还在上传」和「服务器在解析」分开。fetch 下这两段是一个不透明的
 * await,而对一个大 PSD 它们恰好是整个打开流程里最长、且时长差别最大的两段——
 * 合成一段的话,遮罩会在第一步停几十秒,进度感等于没有。
 *
 * 只 resolve body,不判断 `body.success`:那是调用方的事,与换用 XHR 之前
 * 一模一样。请求头一个都不设,原来的 fetch 也没设。
 */
export function postForm(
  url: string,
  fd: FormData,
  onUploaded: () => void,
): Promise<{ success?: boolean; docId?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onload = () => onUploaded();
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        // 网关 5xx 返回的是 HTML 错误页。把 JSON.parse 的语法错误换成状态码,
        // 那才是这里唯一有用的信息。
        reject(new Error(`HTTP ${xhr.status}: 响应不是 JSON`));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.onabort = () => reject(new Error("请求已中断"));
    xhr.send(fd);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/post-form.test.ts`
Expected: PASS，6 条全过

- [ ] **Step 5: 跑整包测试**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add packages/web-psd/src/doc-controller.ts packages/web-psd/tests/post-form.test.ts
git commit -m "feat(web-psd): postForm —— 用 XHR 把上传完成和服务端解析分开"
```

---

### Task 3: 阶段事件穿起来

**Files:**
- Modify: `packages/web-psd/src/doc-controller.ts:31-36`（`DocControllerEvents`）、`:89-92`（`initRender` 开头）、`:130-132`（`renderClient.init` 之前）、`:349-363`（`createFrom`）
- Modify: `packages/web-psd/src/ui/controller.ts:26-32`（`initController` 的回调）、`:85-117`（`createFrom` wrapper）
- Test: `packages/web-psd/tests/open-flow.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `OpenPhase` / `OpenProgress` / `UiState.opening`；Task 2 的 `postForm`
- Produces:
  - `DocControllerEvents.onOpenPhase(phase: OpenPhase): void`
  - `DocControllerEvents.onOpenFailed(error: Error): void`
  - `src/doc-controller.ts` 从 `./ui/store.js` 只 type-import `OpenPhase`

- [ ] **Step 1: 写失败的测试**

新建 `packages/web-psd/tests/open-flow.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-flow.test.ts`
Expected: FAIL —— 第一条就报 `expected undefined to equal { phase: 'upload', … }`

- [ ] **Step 3: 扩 `DocControllerEvents`**

`src/doc-controller.ts`：`import type { Hit }` 那行下面加

```ts
import type { OpenPhase } from "./ui/store.js";
```

`DocControllerEvents` 改成：

```ts
export interface DocControllerEvents {
  onStatus(message: string): void;
  /** Fires whenever the document or version changes: cold start, local op,
   *  rebase (409 / agent run / another tab), rollback. */
  onDoc(doc: DocSession["doc"], version: number): void;
  /** 一次打开走到了新的阶段。只报告,不管 store 里那个 `opening` 字段的
   *  生死——它的写入和清除归 ui/controller.ts 的 wrapper 所有(见那边的
   *  createFrom)。 */
  onOpenPhase(phase: OpenPhase): void;
  /** 打开失败。单独一个事件,是因为 `createFrom` 按设计永不 reject(见
   *  ui/controller.ts 里 `before` 比较那段注释),失败只能这样报出来。
   *  成功没有对应事件:wrapper 的 finally 已经负责收尾。 */
  onOpenFailed(error: Error): void;
}
```

- [ ] **Step 4: 在 `createFrom` / `initRender` 里报阶段**

`src/doc-controller.ts` 的 `initRender`，把开头

```ts
    if (!docId) return;
    this.events.onStatus(`loading ${docId.slice(0, 8)}…`);
```

改成

```ts
    if (!docId) return;
    this.events.onStatus(`loading ${docId.slice(0, 8)}…`);
    this.events.onOpenPhase("load");
```

在 `const cacheBytes = cacheBytesFor(...)` 与 `const workerInitStart = ...` 之间插入：

```ts
    // 解码 + 首绘。这两段在 Worker 里是一段连续的忙,没有可拆的中间点。
    this.events.onOpenPhase("render");
```

`createFrom` 整个换成：

```ts
  async createFrom(bytes: Uint8Array, label: string): Promise<void> {
    this.events.onStatus(`creating from ${label}…`);
    this.events.onOpenPhase("upload");
    try {
      const fd = new FormData();
      fd.append("file", new Blob([bytes as BlobPart]), label);
      const body = await postForm(
        `${GW}/tenants/${USER}/docs/${TYPE}/`,
        fd,
        // 最后一个字节走了,但服务器还要解析 PSD 并写 CAS。对一个大文件这
        // 后半段一点也不短,合进「上传中」会让遮罩看起来卡住。
        () => this.events.onOpenPhase("parse"),
      );
      if (!body.success) throw new Error(body.error ?? "create failed");
      this.docIdField = body.docId ?? null;
      await this.initRender();
      this.events.onStatus(`v${this.session?.version} · ${this.docIdField?.slice(0, 8)}`);
    } catch (e) {
      this.events.onStatus(`failed: ${(e as Error).message}`);
      this.events.onOpenFailed(e as Error);
    }
  }
```

- [ ] **Step 5: 在 controller.ts 里编排 `opening`**

`src/ui/controller.ts`：`initController` 里的 events 对象加两个回调（放在 `onStatus` 后面）：

```ts
    onStatus: (status) => setState({ status }),
    // 只改阶段,不碰同一个字段里的文件名和字节数——它们是 createFrom 播下的。
    onOpenPhase: (phase) => {
      const opening = getState().opening;
      if (opening) setState({ opening: { ...opening, phase } });
    },
    onOpenFailed: (err) => reportError("打开文件失败", err),
```

`createFrom` wrapper（controller.ts:85-117）整个换成下面这段。**函数体里原有的两大段
注释和那个 `if (controller.docId && controller.docId !== before)` 块一字未改**，唯一的
改动是外面套了 try/finally、开头多了一行 seed：

```ts
async function createFrom(bytes: Uint8Array, label: string): Promise<void> {
  if (!controller) return;
  const before = controller.docId;
  // `opening` 的生死归这里,不归 DocController:文件名和字节数只有这一层有,
  // 而放进 finally 意味着任何路径都收得干净——包括 DocController 被替身顶掉、
  // 一个事件都不发的情况。少一个事件就把遮罩永久留在屏幕上,而那是用户完全
  // 无法自救的状态。
  setState({ opening: { phase: "upload", name: label, bytes: bytes.length } });
  try {
    await controller.createFrom(bytes, label);
    // `DocController.createFrom` never rejects — it reports failure only via
    // `onStatus`. Comparing to `before` is what keeps a failed create from
    // adopting the new label: on the very first (never-yet-successful) call
    // `docId` is still `null`; when the POST itself fails it is still the
    // previous document's id, unchanged.
    //
    // The gate is deliberately coarse, and cannot be tightened from here.
    // `createFrom` assigns `docIdField` BEFORE awaiting `initRender()` (see
    // doc-controller.ts), so a create whose POST succeeded but whose render
    // then threw leaves the new docId in place and is indistinguishable, from
    // out here, from a fully successful one — the store adopts the new
    // docId/label while the canvas shows nothing, with `onStatus` carrying the
    // only account of what went wrong. That is the correct trade: the document
    // does exist server-side, so pretending the previous one is still open
    // would be the bigger lie.
    if (controller.docId && controller.docId !== before) {
      // `selection`/`region` are normally cleared by `onDoc`'s fresh branch.
      // They are cleared again here for the path where `initRender` threw
      // BEFORE reaching that callback: the new docId is adopted (see the
      // comment above) while the previous document's target is still in the
      // store, pointing at layer ids that are not in any open document.
      //
      // `region` is cleared through `setRegion`, not folded into the `setState`
      // below, so its mask sweep still runs — a raw `setState({ region: null })`
      // would leave the stale mask's bytes in the module-level table forever.
      setState({ docId: controller.docId, docName: label, history: [], chat: [], selection: [] });
      setRegion(null);
    }
  } finally {
    setState({ opening: null });
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-flow.test.ts`
Expected: PASS，5 条全过

- [ ] **Step 7: 确认没引入 import 环并且类型干净**

`src/doc-controller.ts` 新增的是 `import type`，编译后不产生运行时依赖；但 `no-import-cycles.test.ts` 是按正则扫文本的，会把它算成一条边（`doc-controller.ts → ui/store.ts`）。`ui/store.ts` 只 import `doc-model.js`、`region.js`、`hit-test.js`，不回指 `doc-controller.ts`，所以不成环。

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/no-import-cycles.test.ts`
Expected: PASS

Run: `pnpm --filter @unidocs/web-psd typecheck`
Expected: 无输出（通过）

- [ ] **Step 8: 跑整包测试**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: 全绿。`controller.test.ts` / `export.test.ts` / `app-shell.test.tsx` 里的 DocController 替身没有 `onOpenPhase`，但它们从不调用这两个新回调，只是把 events 对象整个存下来——不受影响。

- [ ] **Step 9: 提交**

```bash
git add packages/web-psd/src/doc-controller.ts packages/web-psd/src/ui/controller.ts \
        packages/web-psd/tests/open-flow.test.ts
git commit -m "feat(web-psd): 打开流程上报四个阶段,遮罩生命周期归 controller"
```

---

### Task 4: 加载期间锁住交互

**Files:**
- Modify: `packages/web-psd/src/ui/panels/top-bar.tsx:58-72`
- Modify: `packages/web-psd/src/ui/panels/side-panel.tsx:25`
- Modify: `packages/web-psd/src/ui/panels/tool-strip.tsx:12`
- Modify: `packages/web-psd/src/ui/panels/chat-panel.tsx:90`
- Modify: `packages/web-psd/src/ui/styles.css`（文件末尾加 `.is-locked`）
- Test: `packages/web-psd/tests/open-locks.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `UiState.opening`
- Produces: 无（纯 UI 行为）

- [ ] **Step 1: 写失败的测试**

新建 `packages/web-psd/tests/open-locks.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { SidePanel } from "../src/ui/panels/side-panel.js";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ChatPanel } from "../src/ui/panels/chat-panel.js";
import { setState } from "../src/ui/store.js";

const { exportDoc, openFile } = vi.hoisted(() => ({
  exportDoc: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
}));

vi.mock("../src/ui/controller.js", () => ({
  getController: () => null,
  exportDoc,
  openFile,
}));

const opening = { phase: "parse", name: "a.psd", bytes: 1024 } as const;

beforeEach(() => {
  exportDoc.mockClear();
  openFile.mockClear();
  setState({ docId: "abcdef0123456789", docName: "a.psd", version: 3 });
});

describe("locks while a file is opening", () => {
  // 这期间 store 里的 doc 前半段还是旧文档、后半段是新文档但没有像素,
  // 任何一处能点的地方都在对一个不该被操作的文档发指令。
  it("disables 打开 so a second open cannot start on top of the first", () => {
    setState({ opening });
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "打开" })).toBeDisabled();
  });

  it("disables 导出 even though a document id is present", () => {
    // docId 此刻指向的可能正是那个正在被替换掉的旧文档。
    setState({ opening });
    render(<TopBar />);
    const button = screen.getByRole("button", { name: "导出" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(exportDoc).not.toHaveBeenCalled();
  });

  it("leaves both buttons live when nothing is opening", () => {
    render(<TopBar />);
    expect(screen.getByRole("button", { name: "打开" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出" })).toBeEnabled();
  });

  // 同一个文件连选两次,第二次不触发 change,看起来像点了没反应。清 value
  // 要在 onChange 里做:openFile 是 async 的,等它回来才清,中间这段时间
  // 同一个文件仍然选不动。
  it("clears the file input so the same file can be picked twice", () => {
    const { container } = render(<TopBar />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const setValue = vi.fn();
    Object.defineProperty(input, "value", {
      set: setValue, get: () => "C:\\fakepath\\a.psd", configurable: true,
    });

    fireEvent.change(input, { target: { files: [{ name: "a.psd" }] } });

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledWith("");
  });

  it("makes the layers/props column inert", () => {
    setState({ opening, doc: { canvas: { width: 1, height: 1 }, layers: [] } as never });
    const { container } = render(<SidePanel />);
    expect(container.querySelector(".col-panel")).toHaveAttribute("inert");
  });

  it("makes the tool strip inert", () => {
    setState({ opening });
    const { container } = render(<ToolStrip />);
    expect(container.querySelector(".tools")).toHaveAttribute("inert");
  });

  it("leaves them interactive when nothing is opening", () => {
    setState({ doc: { canvas: { width: 1, height: 1 }, layers: [] } as never });
    const { container: panel } = render(<SidePanel />);
    expect(panel.querySelector(".col-panel")).not.toHaveAttribute("inert");
    const { container: tools } = render(<ToolStrip />);
    expect(tools.querySelector(".tools")).not.toHaveAttribute("inert");
  });

  // agent 跑在服务端的 docId 上,加载中发消息会打到正在被替换的旧文档。
  it("disables the chat composer", () => {
    setState({ opening });
    render(<ChatPanel />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-locks.test.tsx`
Expected: FAIL —— 「打开」按钮那条先红（`expected element to be disabled`）

- [ ] **Step 3: 改 top-bar.tsx**

把「打开」按钮、file input、「导出」按钮那三段换成：

```tsx
      <button
        type="button" className="btn"
        disabled={!!s.opening}
        onClick={() => fileRef.current?.click()}
      >打开</button>
      <input
        ref={fileRef} type="file" accept=".psd" hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 立刻清空,不等 openFile 回来:同一个文件连选两次,第二次不触发
          // change,看起来像点了没反应。openFile 是 async 的,放到它之后清
          // 就等于在整个加载期间都留着这个坑。
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />
      {/* A button, not a link: the export has to flush the pending-op queue
          to the server before reading the document back from it, and a plain
          <a href> navigates without running any of our code. */}
      <button
        type="button" className="btn btn-primary"
        // `opening` 期间 docId 指向的可能正是那个正在被替换掉的旧文档。
        disabled={!s.docId || s.exporting || !!s.opening}
        onClick={() => { void exportDoc(); }}
      >
        {s.exporting ? "导出中…" : "导出"}
      </button>
```

- [ ] **Step 4: 改 side-panel.tsx 和 tool-strip.tsx**

`side-panel.tsx` 的 `<aside>` 改成：

```tsx
    // `inert` 而不是给每个控件挂 disabled:它一次盖住指针、键盘焦点和 a11y
    // 树,而逐个 disabled 既要改十几处,又漏掉树里那些不是 <button> 的可点行。
    // `.is-locked` 只管视觉,不承担任何拦截职责。
    <aside className={`col-panel${s.opening ? " is-locked" : ""}`} inert={!!s.opening}>
```

`tool-strip.tsx` 的 `<div className="tools">` 改成：

```tsx
    <div className={`tools${s.opening ? " is-locked" : ""}`} inert={!!s.opening}>
```

- [ ] **Step 5: 改 chat-panel.tsx**

第 90 行改成：

```tsx
      <Composer busy={s.chatBusy || !!s.opening} onSend={(t, target) => void send(t, target)} />
```

- [ ] **Step 6: 加 `.is-locked` 样式**

`src/ui/styles.css` 末尾（`.open-phase` 之后）加：

```css
/* 打开文件期间被 `inert` 冻住的区域。纯视觉——拦截是 `inert` 的事。 */
.is-locked { opacity: .45; }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @unidocs/web-psd exec vitest run tests/open-locks.test.tsx`
Expected: PASS，8 条全过

- [ ] **Step 8: 跑整包测试与类型检查**

Run: `pnpm --filter @unidocs/web-psd test`
Expected: 全绿

Run: `pnpm --filter @unidocs/web-psd typecheck`
Expected: 无输出

- [ ] **Step 9: 真机冒烟**

jsdom 不套用样式表，遮罩的定位、盖住范围、脉冲动画都断言不到，只能看。

```bash
pnpm dev psd
```

浏览器打开 web-psd，点「打开」选一个 PSD，确认：
1. 遮罩盖住画布和下面的 context bar，**不盖**左侧聊天栏和右侧图层栏；
2. 四个点按 上传 → 解析 → 载入 → 渲染 推进，当前那个在脉冲；
3. 加载期间「打开」「导出」是灰的，图层栏和工具条是淡的且点不动，聊天「发送」是灰的；
4. 加载完遮罩消失，画布有像素，一切恢复可点；
5. 打开同一个文件第二次仍然会触发加载（file input 的 value 已清）。

- [ ] **Step 10: 提交**

```bash
git add packages/web-psd/src/ui/panels/top-bar.tsx packages/web-psd/src/ui/panels/side-panel.tsx \
        packages/web-psd/src/ui/panels/tool-strip.tsx packages/web-psd/src/ui/panels/chat-panel.tsx \
        packages/web-psd/src/ui/styles.css packages/web-psd/tests/open-locks.test.tsx
git commit -m "feat(web-psd): 打开文件期间锁住打开/导出/面板/聊天发送"
```
