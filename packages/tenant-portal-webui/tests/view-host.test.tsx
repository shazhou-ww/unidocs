import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VersionRecord } from "@unidocs/protocol-platform";
import { ViewHost } from "../src/view/view-host.js";
import type { ViewChannel } from "../src/view/channel.js";

const version = {
  versionIdx: 0,
  parentVersionIdx: null,
  documentContractIdx: 0,
  snapshot: { content: "# 标题\n\n正文。\n" },
  authorAgentId: "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as VersionRecord;

function flushMicrotasks(times = 4): Promise<void> {
  return (async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  })();
}

describe("ViewHost", () => {
  // 回归测试：曾经三次连续 await channel.callView(...) 之间没有取消守卫，组件
  // 在链条中途卸载（channel 随第一个 effect 的 cleanup 一起被 dispose）会继续
  // 对已释放的 channel 发起 loadSnapshot/setMarkers 调用——那一步同步抛出
  // "view channel is disposed" 并变成 unhandled promise rejection（在修复前
  // 用 `git stash` 验证过：vitest 会把它作为 Unhandled Rejection 报出来，
  // 整个 test file 失败退出码非 0）。现在每一步 await 前都会检查 cancelled，
  // 所以 dispose 之后不应再有 loadSnapshot / setMarkers 被调用。
  //
  // 没有额外写一条监听 window "unhandledrejection" 的测试：在这个
  // vitest(jsdom) 环境里实测过，即便对着修复前会真实抛出 unhandled rejection
  // 的代码跑，`window.addEventListener("unhandledrejection", ...)` 也收不到
  // 任何事件（jsdom 不会把 Node 的 unhandled promise rejection 转发成
  // window 事件），这条断言在两种代码下都恒为真，写出来只是凑数。这一层的
  // 真实保护来自 vitest 自身的 unhandled-rejection 检测——修复前重跑这条测试
  // 会看到 "Unhandled Rejection: view channel is disposed; loadSnapshot
  // rejected" 被 vitest 报出来并让整个文件失败，不需要也不能在测试代码里
  // 重新断言它。
  it("卸载后不再对已释放的 channel 发起后续调用", async () => {
    const calls: string[] = [];
    let captured: ViewChannel | null = null;

    const { unmount } = render(
      <ViewHost
        label="当前版本"
        version={version}
        markers={[]}
        onReady={(channel) => {
          captured = channel;
          // 在真实 callView 外面套一层记录，观测哪些方法真的被调用了；
          // createLocalChannel 是同一个 tick 内 resolve 的假通道，所以这里
          // 只关心「调用了哪些方法」这一可观测事实，不依赖计时。
          const original = channel.callView.bind(channel);
          channel.callView = ((method, request) => {
            calls.push(method as string);
            return original(method as never, request as never);
          }) as typeof channel.callView;
        }}
      />,
    );

    expect(captured).not.toBeNull();
    // 挂载的第二个 effect 已经同步发起了 initialize 调用（它在第一次 await 处
    // 让出，还没轮到 loadSnapshot / setMarkers）。
    expect(calls).toEqual(["initialize"]);

    unmount();
    await flushMicrotasks();

    // 卸载触发的 cleanup 会对同一个 channel 调用一次 dispose；除此之外，
    // 链条里原本要发的 loadSnapshot、setMarkers 必须被 cancelled 挡住，
    // 不能再打到已经 dispose 掉的 channel 上。
    expect(calls).toEqual(["initialize", "dispose"]);
  });
});
