import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { createMarkdownView } from "../src/view/markdown-view.js";
import type { HostImplementation } from "../src/view/channel.js";

const content = "# 标题\n\n第一段内容。\n\n第二段内容。\n";
const host = {} as HostImplementation;
const context = { contextId: "c1", document: {}, viewVersion: null, viewBundleId: "vb", readOnly: true } as never;

function mounted(options: { commentable?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, view: createMarkdownView({ container, ...options }) };
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
        { threadId: "th-1", commentIdx: 0, open: true, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }), role: "ping" },
        { threadId: "th-2", commentIdx: 0, open: false, location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第二段内容。"), end: content.indexOf("第二段内容。") + 6 }), role: "pong-result" },
      ] as never,
    }, host);

    expect(container.querySelector(".marker-ping")?.textContent).toBe("第一段内容。");
    expect(container.querySelector(".marker-pong-result")?.textContent).toBe("第二段内容。");
  });

  it("setMarkers 覆盖上一批，不叠加", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);
    const marker = (quote: string, role: string) => ({
      threadId: "th-1", commentIdx: 0, open: true, role,
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
        { threadId: "th-gone", commentIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content: "别处的原文", start: 0, end: 5 }) },
        { threadId: "th-ok", commentIdx: 0, open: true, role: "ping", location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }) },
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

  it("锚点原文重复出现时,高亮定位到正确的一处而不是永远第一处", async () => {
    const quote = "重复的句子。";
    const repeatedContent = `${quote}\n\n${quote}\n\n${quote}\n`;
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content: repeatedContent } as never }, host);

    const firstAt = repeatedContent.indexOf(quote);
    const secondAt = repeatedContent.indexOf(quote, firstAt + 1);
    expect(secondAt).toBeGreaterThan(firstAt);

    await view.setMarkers({
      revision: 1,
      markers: [
        {
          threadId: "th-1",
          commentIdx: 0,
          open: true,
          role: "ping",
          location: createMarkdownTextRange({ documentContractIdx: 0, content: repeatedContent, start: secondAt, end: secondAt + quote.length }),
        },
      ] as never,
    }, host);

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.querySelector(".marker-ping")).toBeNull();
    expect(paragraphs[1]?.querySelector(".marker-ping")).not.toBeNull();
    expect(paragraphs[2]?.querySelector(".marker-ping")).toBeNull();
    expect(container.querySelectorAll(".marker-ping")).toHaveLength(1);
  });

  it("focusLocation 滚动到正确的元素,而不是 DOM 里任意一个 mark", async () => {
    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content } as never }, host);

    // 先给第一段建一个 mark,制造「容器里已经有别的 mark」的情形。
    await view.setMarkers({
      revision: 1,
      markers: [
        {
          threadId: "th-1",
          commentIdx: 0,
          open: true,
          role: "ping",
          location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第一段内容。"), end: content.indexOf("第一段内容。") + 6 }),
        },
      ] as never,
    }, host);

    const scrolledOn: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolledOn.push(this);
    });
    Element.prototype.scrollIntoView = scrollIntoView as typeof original;

    try {
      const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("第二段内容。"), end: content.indexOf("第二段内容。") + 6 });
      const result = await view.focusLocation(location, host);

      expect(result).toEqual({ located: true, reason: "located" });
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrolledOn).toHaveLength(1);
      expect(scrolledOn[0]?.textContent).toContain("第二段内容。");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("原文重叠(一个锚点的原文是另一个已高亮原文的子串)不抛异常,clearMarkers 完全还原", async () => {
    const overlapContent = "这是较长的原文片段。\n\n第二段。\n";
    const outer = "较长的原文片段";
    const inner = "长的原文";
    const outerStart = overlapContent.indexOf(outer);
    const innerStart = overlapContent.indexOf(inner);
    expect(innerStart).toBeGreaterThanOrEqual(outerStart);
    expect(innerStart + inner.length).toBeLessThanOrEqual(outerStart + outer.length);

    const { container, view } = mounted();
    await view.loadSnapshot({ context, snapshot: { content: overlapContent } as never }, host);

    await expect(view.setMarkers({
      revision: 1,
      markers: [
        {
          threadId: "th-outer",
          commentIdx: 0,
          open: true,
          role: "ping",
          location: createMarkdownTextRange({ documentContractIdx: 0, content: overlapContent, start: outerStart, end: outerStart + outer.length }),
        },
        {
          threadId: "th-inner",
          commentIdx: 0,
          open: true,
          role: "pong-result",
          location: createMarkdownTextRange({ documentContractIdx: 0, content: overlapContent, start: innerStart, end: innerStart + inner.length }),
        },
      ] as never,
    }, host)).resolves.toBeUndefined();

    await view.setMarkers({ revision: 2, markers: [] as never }, host);

    expect(container.querySelectorAll(".marker")).toHaveLength(0);
    expect(container.textContent).toContain("这是较长的原文片段。");
    expect(container.textContent).toContain("第二段。");
  });

  // 问题 2：没有真实 host 的栏位（比如左栏「评论所基于的版本」那种历史版本对照）
  // 不该装「添加评论」触发器——装了点了也必然失败，是一条死路。jsdom 的 Range 没
  // 实现 getBoundingClientRect（见 anchorRect 的防御性 try/catch），选区+mouseup
  // 端到端走不通，所以这里不去模拟一次真实选区，而是直接断言监听器本身有没有被
  // 注册——这是 commentable 唯一控制的事，断言它就是断言这条修复本身，不依赖
  // 走不通的几何 API。
  it("commentable 为 false 时不注册 mouseup 监听（不装选区触发器）", () => {
    const { container } = mounted();
    const addSpy = vi.spyOn(container, "addEventListener");

    createMarkdownView({ container, commentable: false });

    expect(addSpy).not.toHaveBeenCalledWith("mouseup", expect.any(Function));
  });

  it("commentable 默认为 true 时会注册 mouseup 监听（选区触发器由它驱动）", () => {
    const { container } = mounted();
    const addSpy = vi.spyOn(container, "addEventListener");

    createMarkdownView({ container });

    expect(addSpy).toHaveBeenCalledWith("mouseup", expect.any(Function));
  });

  // 选区「添加评论」：View 只负责把选区编码成 DocumentLocation 交给 host
  // （host.composeComment），输入框由 host 在讨论面板里打开——和「回复」是同一个
  // 输入框，View 自己不再浮出第二种输入框。
  //
  // 浏览器里一次点击是 mousedown → mouseup → click。触发按钮挂在容器里，它的 mouseup
  // 会冒泡到容器的选区监听上；监听若在这时重建浮层，被按下的按钮在 click 之前就已
  // 脱离文档，浏览器不再派发 click——「添加评论」点了没反应。jsdom 会照样把 click
  // 派发给脱离文档的元素，所以这里断言的是「mouseup 之后被按下的那个按钮仍在文档里」。
  describe("选区「添加评论」", () => {
    const original = Range.prototype.getBoundingClientRect;
    beforeEach(() => {
      Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 10);
      return () => { Range.prototype.getBoundingClientRect = original; };
    });

    async function selectHeading() {
      const { container, view } = mounted();
      const composeComment = vi.fn(async () => undefined);
      const realHost = { composeComment } as unknown as HostImplementation;
      const versioned = { ...(context as object), viewVersion: { versionIdx: 3, documentContractIdx: 0 } } as never;
      await view.initialize({ protocol: "unidocs-view-host/v1", context: versioned, mode: { kind: "interactive" } }, realHost);
      await view.loadSnapshot({ context: versioned, snapshot: { content } as never }, realHost);

      const text = container.querySelector("h1")!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 2);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { container, composeComment };
    }

    it("点「添加评论」时 mouseup 不替换掉被按下的触发按钮", async () => {
      const { container } = await selectHeading();
      const trigger = container.querySelector<HTMLButtonElement>(".add-comment-trigger");
      expect(trigger).not.toBeNull();

      trigger!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(trigger!.isConnected).toBe(true);
    });

    it("点「添加评论」把选区位置交给 host，View 自己不浮出输入框", async () => {
      const { container, composeComment } = await selectHeading();

      container.querySelector<HTMLButtonElement>(".add-comment-trigger")!.click();

      await vi.waitFor(() => expect(composeComment).toHaveBeenCalledOnce());
      expect(composeComment).toHaveBeenCalledWith({
        baseVersionIdx: 3,
        location: createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf("标题"), end: content.indexOf("标题") + 2 }),
      });
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector(".add-comment-trigger")).toBeNull();
    });
  });

  // 注：原本还想再加一条「commentable: false 时，就算容器上真的发生了 mouseup
  // 也不渲染触发按钮」的端到端断言，但验证时发现它对实现不敏感——jsdom 里不设置
  // 真实选区直接 dispatch mouseup，currentSelectionRange() 本来就会返回 null
  // （既有的「有选区才出触发按钮」判断），所以哪怕故意把 commentable 短路成恒为
  // true，这条断言照样通过，测不出问题。真正能分辨行为的是上面这两条对
  // addEventListener 的断言，索性不留这条恒真的。
});
