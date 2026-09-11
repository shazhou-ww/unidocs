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

    const context = {
      contextId: props.label,
      document: {} as never,
      viewVersion: props.version,
      viewBundleId: "local-markdown",
      readOnly: true,
    };

    void (async () => {
      await channel.callView("initialize", {
        protocol: "unidocs-view-host/v1",
        context: context as never,
        mode: { kind: "interactive" },
      });
      await channel.callView("loadSnapshot", {
        context: context as never,
        snapshot: (props.version?.snapshot ?? null) as SValue | null,
      });
      await channel.callView("setMarkers", {
        revision: 1,
        // role 尚未进协议（见 view/markers.ts），本地通道下原样透传；
        // 换成 postMessage 前必须先把 role 加进协议 marker。
        markers: props.markers as never,
      });
    })();
  }, [props.label, props.version, props.markers]);

  return <div ref={containerRef} role="region" aria-label={props.label} className={props.className} />;
}
