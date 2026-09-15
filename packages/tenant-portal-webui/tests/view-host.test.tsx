import { render } from "@testing-library/react";
import type { HostImplementation } from "../src/view/channel.js";
import { describe, expect, it, vi } from "vitest";
import type { SValue, VersionRecord } from "@unidocs/protocol-platform";
import { ViewHost } from "../src/view/view-host.js";
import type { ViewChannel } from "../src/view/channel.js";

// VersionRecord 不再携带 snapshot——它是独立的 client.getVersionSnapshot 调用结果，
// 测试里同样拆成两份分别传给 ViewHost 的 version/snapshot 两个 prop。
const version = {
  versionIdx: 0,
  parentVersionIdx: null,
  documentContractIdx: 0,
  authorAgentId: "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as VersionRecord;

const snapshot = { content: "# 标题\n\n正文。\n" } as unknown as SValue;

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
        snapshot={snapshot}
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

  // 问题 3 的回归测试：ViewHost 的挂载 effect 依赖数组是 []，通道和 host 只在
  // 首次挂载时建一次。document.tsx 依赖“文档切换时强制重新挂载”来避免通道永远
  // 绑在旧文档的 host 上——具体做法是给两个 <ViewHost> 都加上带 documentId 的
  // key。这里直接在 ViewHost 这一层验证该机制本身：key 不变时重渲染不会重建
  // 通道（对应过去的 bug——props.host 变了也没用）；key 变了才会重建，拿到一个
  // 全新的通道，旧的那个被 dispose 掉。
  //
  // 这条测不到、也不打算测 document.tsx 里 `key={documentId + label}` 这个具体
  // 表达式本身——端到端验证那一步需要真的通过选区触发 host.createThread，而
  // jsdom 的 Selection/Range 支持不完整（见 markdown-view.test.ts 里的说明），
  // 走不通。这里验证的是 document.tsx 那个修法所依赖的底层机制：key 换了，
  // ViewHost 就会整个重新挂载，从而拿到一个绑定新 host 的全新通道——这个机制
  // 本身是可以在 jsdom 下完整观测的，不依赖任何几何/选区 API。
  it("key 不变时重渲染不会重建通道——这正是问题 3 的成因", async () => {
    const hostA: HostImplementation = {
      readBlob: async () => { throw new Error("n/a"); },
      listThreads: async () => ({ items: [], nextCursor: null }),
      getThread: async () => { throw new Error("n/a"); },
      createThread: async () => { throw new Error("host A"); },
      appendComment: async () => { throw new Error("n/a"); },
      storeBlob: async () => { throw new Error("n/a"); },
      composeComment: async () => { throw new Error("n/a"); },
    };
    const hostB: HostImplementation = { ...hostA, createThread: async () => { throw new Error("host B"); } };

    const ready = vi.fn();
    const { rerender } = render(<ViewHost label="当前版本" version={version} snapshot={snapshot} markers={[]} host={hostA} onReady={ready} />);

    expect(ready).toHaveBeenCalledTimes(1);

    // 换了 host（模拟 document.tsx 里 viewHost 因为文档变了而重算出一个新对象），
    // 但没换 key——这正是修复前 app.tsx 不带 key 渲染 DocumentPage 时的处境。
    // 挂载 effect 依赖数组是 []，不会重新跑，onReady 不应该再被调用。
    rerender(<ViewHost label="当前版本" version={version} snapshot={snapshot} markers={[]} host={hostB} onReady={ready} />);
    await flushMicrotasks();

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("key 随文档变化时会强制重新挂载，拿到绑定新 host 的全新通道，旧通道被 dispose", async () => {
    const hostA: HostImplementation = {
      readBlob: async () => { throw new Error("n/a"); },
      listThreads: async () => ({ items: [], nextCursor: null }),
      getThread: async () => { throw new Error("n/a"); },
      createThread: async () => { throw new Error("host A"); },
      appendComment: async () => { throw new Error("n/a"); },
      storeBlob: async () => { throw new Error("n/a"); },
      composeComment: async () => { throw new Error("n/a"); },
    };
    const hostB: HostImplementation = { ...hostA, createThread: async () => { throw new Error("host B"); } };

    const channels: ViewChannel[] = [];
    const disposedCalls: string[] = [];
    const onReady = (channel: ViewChannel) => {
      channels.push(channel);
      const original = channel.callView.bind(channel);
      channel.callView = ((method, request) => {
        if (method === "dispose") disposedCalls.push(`channel-${channels.length}`);
        return original(method as never, request as never);
      }) as typeof channel.callView;
    };

    const { rerender } = render(
      <ViewHost key="doc-A" label="当前版本" version={version} snapshot={snapshot} markers={[]} host={hostA} onReady={onReady} />,
    );
    await flushMicrotasks();
    expect(channels).toHaveLength(1);

    // 对应 document.tsx 里 key={`${props.documentId}:current`}：documentId 变了，
    // key 跟着变——这一步强制 React 把整棵子树当成不同的组件实例，卸载旧的、
    // 挂载一个全新的。
    rerender(<ViewHost key="doc-B" label="当前版本" version={version} snapshot={snapshot} markers={[]} host={hostB} onReady={onReady} />);
    await flushMicrotasks();

    // 新建了第二个通道，不是复用第一个——绑定的 host 因此也是全新算出来的那个，
    // 不会再吃到旧文档的 host。
    expect(channels).toHaveLength(2);
    expect(channels[1]).not.toBe(channels[0]);
    // 旧通道在卸载时被 dispose 掉，不会继续悬挂着绑在旧 host 上。
    expect(disposedCalls).toEqual(["channel-1"]);
  });
});
