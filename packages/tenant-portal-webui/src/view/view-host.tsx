import { useEffect, useRef } from "react";
import type { SValue, VersionRecord } from "@unidocs/protocol-platform";
import { createLocalChannel, type HostImplementation, type ViewChannel } from "./channel.js";
import { createMarkdownView } from "./markdown-view.js";
import type { RoledMarker } from "./markers.js";

const noopHost: HostImplementation = {
  readBlob: async () => { throw new Error("readBlob is not available in this round"); },
  listThreads: async () => ({ items: [], nextCursor: null }),
  getThread: async () => { throw new Error("getThread is not available in this round"); },
  createThread: async () => { throw new Error("createThread is wired in Task 15"); },
  appendPing: async () => { throw new Error("appendPing is wired in Task 15"); },
  storeBlob: async () => { throw new Error("storeBlob is not available in this round"); },
};

export function ViewHost(props: {
  label: string;
  version: VersionRecord | null;
  markers: readonly RoledMarker[];
  host?: HostImplementation;
  className?: string;
  onReady?: (channel: ViewChannel) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ViewChannel | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const channel = createLocalChannel({
      view: createMarkdownView({ container }),
      host: props.host ?? noopHost,
    });
    channelRef.current = channel;
    props.onReady?.(channel);

    return () => {
      void channel.callView("dispose", {}).catch(() => undefined);
      channel.dispose();
      channelRef.current = null;
    };
    // host 与 onReady 的身份变化不应重建 view；只在挂载时建一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const channel = channelRef.current;
    if (channel === null) return;
    // 三次 await 之间组件可能卸载、channel 可能被 dispose，或者 props 又变了一轮
    // （分屏对照下两栏各自独立加载，下一轮请求可能先于本轮返回）。cancelled 标志
    // 保证过期的链条在每一步都提前退出，不对已释放的通道发起调用，也不用过期结果
    // 覆盖新结果——与 use-document.ts 里 useDocumentSession 的取消模式一致。
    let cancelled = false;

    const context = {
      contextId: props.label,
      document: {} as never,
      viewVersion: props.version,
      viewBundleId: "local-markdown",
      readOnly: true,
    };

    void (async () => {
      try {
        if (cancelled) return;
        await channel.callView("initialize", {
          protocol: "unidocs-view-host/v1",
          context: context as never,
          mode: { kind: "interactive" },
        });
        if (cancelled) return;
        await channel.callView("loadSnapshot", {
          context: context as never,
          snapshot: (props.version?.snapshot ?? null) as SValue | null,
        });
        if (cancelled) return;
        await channel.callView("setMarkers", {
          revision: 1,
          // role 尚未进协议（见 view/markers.ts），本地通道下原样透传；
          // 换成 postMessage 前必须先把 role 加进协议 marker。
          markers: props.markers as never,
        });
      } catch (cause) {
        // cancelled 时通道多半已经 dispose，报错是意料之中，安静地丢弃；
        // 非 cancelled 的失败目前没有专门的错误 UI（那是别的 task 的事），
        // 但至少留一条 console 记录，不要完全静默吞掉真实失败。
        if (!cancelled) console.error("ViewHost failed to sync view", cause);
      }
    })();

    return () => { cancelled = true; };
  }, [props.label, props.version, props.markers]);

  return <div ref={containerRef} role="region" aria-label={props.label} className={props.className} />;
}
