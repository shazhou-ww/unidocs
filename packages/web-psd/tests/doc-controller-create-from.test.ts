import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocController } from "../src/doc-controller.js";

/** 最小的 XMLHttpRequest 替身,和 post-form.test.ts 同一套——jsdom 自带的
 *  那个会真的去发请求。这里只测「响应到达之后」的分支,所以不用管
 *  upload.onload。 */
class FakeXHR {
  static last: FakeXHR | null = null;
  upload: { onload: (() => void) | null } = { onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = "";
  status = 200;
  sentBody: FormData | null = null;
  constructor() { FakeXHR.last = this; }
  open(): void {}
  send(body: FormData): void { this.sentBody = body; }
}

function newController(events: {
  onStatus: (s: string) => void;
  onDoc: (doc: unknown, version: number) => void;
  onOpenPhase: (p: string) => void;
  onOpenFailed: (e: Error) => void;
}): DocController {
  return new DocController(
    document.createElement("canvas"),
    document.createElement("div"),
    events as never,
  );
}

beforeEach(() => {
  FakeXHR.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

// `initRender` (Worker + real network) is never reached on this path — the
// `docId` check throws before `createFrom` gets there — so this can drive the
// REAL `DocController`, not the test-suite's usual mock.
describe("DocController.createFrom: a `{success:true}` body with no docId", () => {
  it("throws instead of silently ending the open, and reports it via onOpenFailed", async () => {
    const onStatus = vi.fn();
    const onOpenFailed = vi.fn();
    const onDoc = vi.fn();
    const controller = newController({ onStatus, onDoc, onOpenPhase: vi.fn(), onOpenFailed });

    const p = controller.createFrom(new Uint8Array([1, 2, 3]), "a.psd");
    FakeXHR.last!.responseText = JSON.stringify({ success: true });
    FakeXHR.last!.onload!();
    await p;

    expect(onOpenFailed).toHaveBeenCalledTimes(1);
    expect(onOpenFailed.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onOpenFailed.mock.calls[0][0] as Error).message).toBe("服务端没有返回 docId");
    // Without the throw this would have silently "succeeded": docId stays
    // unset and initRender/onDoc is never reached — no `vundefined ·
    // undefined` status line, no doc adopted.
    expect(controller.docId).toBeNull();
    expect(onDoc).not.toHaveBeenCalled();
  });

  // The catch block used to write `onStatus(\`failed: ...\`)` immediately
  // before `onOpenFailed`, whose handler (`reportError` in ui/store.ts)
  // always overwrites `status` — so that first write never survived to be
  // seen. Deleting it must not change onOpenFailed's own reporting.
  it("does not also write a dead 'failed: ...' onStatus message", async () => {
    const onStatus = vi.fn();
    const controller = newController({
      onStatus, onDoc: vi.fn(), onOpenPhase: vi.fn(), onOpenFailed: vi.fn(),
    });

    const p = controller.createFrom(new Uint8Array([1, 2, 3]), "a.psd");
    FakeXHR.last!.responseText = JSON.stringify({ success: true });
    FakeXHR.last!.onload!();
    await p;

    expect(onStatus.mock.calls.some(([msg]) => String(msg).startsWith("failed:"))).toBe(false);
  });
});

// M1: `fd.append("file", new Blob([bytes]), label)` 只带了文件名,MIME 丢了
// (`Blob` 不给 `type` 时默认为 `""`)。`openFile` 手里有真正的 `File`,现在
// 把 `file.type` 一路带下去。
describe("DocController.createFrom: 把 MIME 一路带到 FormData 的 Blob 上", () => {
  it("给了 mimeType 就落在 Blob.type 上", async () => {
    const controller = newController({
      onStatus: vi.fn(), onDoc: vi.fn(), onOpenPhase: vi.fn(), onOpenFailed: vi.fn(),
    });

    const p = controller.createFrom(new Uint8Array([1, 2, 3]), "a.png", "image/png");
    FakeXHR.last!.responseText = JSON.stringify({ success: true, docId: "d1" });
    FakeXHR.last!.onload!();
    await p.catch(() => {});

    const file = FakeXHR.last!.sentBody!.get("file") as File;
    expect(file.type).toBe("image/png");
  });

  it("不给 mimeType 时 Blob.type 仍是空串,行为不变", async () => {
    const controller = newController({
      onStatus: vi.fn(), onDoc: vi.fn(), onOpenPhase: vi.fn(), onOpenFailed: vi.fn(),
    });

    const p = controller.createFrom(new Uint8Array([1, 2, 3]), "a.psd");
    FakeXHR.last!.responseText = JSON.stringify({ success: true, docId: "d1" });
    FakeXHR.last!.onload!();
    await p.catch(() => {});

    const file = FakeXHR.last!.sentBody!.get("file") as File;
    expect(file.type).toBe("");
  });
});
