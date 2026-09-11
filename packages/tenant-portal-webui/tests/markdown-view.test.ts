import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { createMarkdownView } from "../src/view/markdown-view.js";
import type { HostImplementation } from "../src/view/channel.js";

const content = "# 标题\n\n第一段内容。\n\n第二段内容。\n";
const host = {} as HostImplementation;
const context = { contextId: "c1", document: {}, viewVersion: null, viewBundleId: "vb", readOnly: true } as never;

function mounted() {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, view: createMarkdownView({ container }) };
}

describe("MarkdownView", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("initialize 接受协议版本", async () => {
    const { view } = mounted();
    const result = await view.initialize({ protocol: "unidocs-view-host/v1", context, mode: { kind: "interactive" } }, host);
    expect(result.acceptedProtocol).toBe("unidocs-view-host/v1");
  });

  it("loadSnapshot 渲染 Markdown 并返回渲染的版本号", async () => {
    const { container, view } = mounted();

    const result = await view.loadSnapshot(
      { context: { ...(context as object), viewVersion: { versionIdx: 2 } } as never, snapshot: { content } as never },
      host,
    );

    expect(result.renderedVersionIdx).toBe(2);
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.textContent).toContain("第一段内容。");
  });

  it("清理掉危险标记", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content: "正常\n\n<img src=x onerror=alert(1)>\n" } as never }, host);

    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("snapshot 为 null 时渲染空，不抛错", async () => {
    const { container, view } = mounted();
    const result = await view.loadSnapshot({ context, snapshot: null }, host);

    expect(result.renderedVersionIdx).toBeNull();
    expect(container.textContent?.trim()).toBe("");
  });

  it("setMarkers 按 role 给不同的 class", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.setMarkers({
      revision: 1,
      markers: [
        { threadId: "th-1", pingIdx: 0, open: true, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }), role: "ping" },
        { threadId: "th-2", pingIdx: 0, open: false, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第二段内容。"), end: content.indexOf("第二段内容。") + 6 }), role: "pong-result" },
      ] as never,
    }, host);

    expect(container.querySelector(".marker-ping")?.textContent).toBe("第一段内容。");
    expect(container.querySelector(".marker-pong-result")?.textContent).toBe("第二段内容。");
  });

  it("setMarkers 覆盖上一批，不叠加", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);
    const marker = (quote: string, role: string) => ({
      threadId: "th-1", pingIdx: 0, open: true, role,
      location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length }),
    });

    await view.setMarkers({ revision: 1, markers: [marker("第一段内容。", "ping")] as never }, host);
    await view.setMarkers({ revision: 2, markers: [marker("第二段内容。", "ping")] as never }, host);

    expect(container.querySelectorAll(".marker-ping")).toHaveLength(1);
    expect(container.querySelector(".marker-ping")?.textContent).toBe("第二段内容。");
  });

  it("定位不到的 marker 被静默跳过，不影响其他 marker", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.setMarkers({
      revision: 1,
      markers: [
        { threadId: "th-gone", pingIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content: "别处的原文", start: 0, end: 5 }) },
        { threadId: "th-ok", pingIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }) },
      ] as never,
    }, host);

    expect(container.querySelectorAll(".marker-ping")).toHaveLength(1);
  });

  it("focusLocation 在内容还在时返回 located", async () => {
    const { view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 });
    expect(await view.focusLocation(location, host)).toEqual({ located: true, reason: "located" });
  });

  it("focusLocation 在原文被改写后返回 unresolvable", async () => {
    const { view } = mounted();
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 });

    await view.loadSnapshot({ context, snapshot: { content: "# 标题\n\n完全换过了。\n" } as never }, host);

    expect(await view.focusLocation(location, host)).toEqual({ located: false, reason: "unresolvable" });
  });

  it("focusLocation 对认不出的 locationType 返回 unsupported_type", async () => {
    const { view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    const result = await view.focusLocation(
      { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} },
      host,
    );
    expect(result).toEqual({ located: false, reason: "unsupported_type" });
  });

  it("dispose 后容器被清空", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    await view.dispose({}, host);

    expect(container.innerHTML).toBe("");
  });
});
