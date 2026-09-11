import { useEffect, useMemo, useState } from "react";
import type { PingRecord, VersionRecord } from "@unidocs/protocol-platform";
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { decideRightPane, type RightPaneDecision } from "../model/compare.js";
import { useDocumentSession } from "../model/use-document.js";
import { useClient } from "../client-context.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { ViewHost } from "../view/view-host.js";
import type { RoledMarker } from "../view/markers.js";
import "./document.css";

const RIGHT_PANE_NOTE: Readonly<Record<RightPaneDecision["kind"], string | null>> = {
  "pong-result": null,
  "same-version": "暂无改动 · 与左栏同一版本",
  "stale-present": "这段内容还在，但这不是 Agent 的改动——常见成因是它处理别的一处评论时顺带改动了附近内容。",
  "stale-rewritten": "这段内容已经不在当前版本里。平台不做语义迁移，这条评论依然有效，由 Agent 判断它是否仍然适用；常见成因是它处理别的一处评论时顺带改动了这里。",
};

export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  const client = useClient();
  const session = useDocumentSession(props.documentId);
  const [baseVersion, setBaseVersion] = useState<VersionRecord | null>(null);

  const selected = session.summary?.threads.find(({ detail }) => detail.threadId === props.threadId) ?? null;
  const ping: PingRecord | null = selected === null
    ? null
    : (selected.detail.pings.find((candidate) => candidate.pingIdx === props.pingIdx)
      ?? selected.detail.pings[selected.detail.pings.length - 1]
      ?? null);

  // 分屏对照下两栏各自独立加载：左栏基版由 ping.baseVersionIdx 决定，与右栏的 current 请求
  // 相互独立，一旦选中的 ping/thread 变化就要重新拉取，并在组件卸载或下一轮请求抢先时取消。
  useEffect(() => {
    if (ping === null) { setBaseVersion(null); return; }
    let cancelled = false;
    void client.getVersion(props.documentId, ping.baseVersionIdx)
      .then((version) => { if (!cancelled) setBaseVersion(version); })
      .catch(() => { if (!cancelled) setBaseVersion(null); });
    return () => { cancelled = true; };
  }, [client, props.documentId, ping?.baseVersionIdx]);

  const currentContent = (session.currentVersion?.snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";
  const currentVersionIdx = session.document?.currentVersionIdx ?? null;

  const decision = useMemo<RightPaneDecision | null>(() => {
    if (ping === null || selected === null) return null;
    return decideRightPane({
      ping,
      pongs: selected.detail.pongs,
      currentVersionIdx,
      currentContent,
    });
  }, [ping, selected, currentVersionIdx, currentContent]);

  // Ruling B: decideRightPane 不知道 threadId，markers 里带的是空串；两栏都要在这里补上
  // 真实值，否则渲染出的 mark[data-thread-id] 是空的，将来点高亮反查 thread 会悄悄失效。
  // Ruling C: ViewHost 的 view-sync effect 把 markers 列进依赖数组，这里必须 useMemo
  // 让数组引用稳定，否则父组件每次渲染都会重新触发三次 RPC。
  const leftMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (ping === null || ping.location === null || selected === null) return [];
    return [{
      threadId: props.threadId ?? "",
      pingIdx: ping.pingIdx,
      open: selected.state.open,
      location: ping.location,
      role: "ping" as const,
    }];
  }, [ping, selected, props.threadId]);

  const rightMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (decision === null) return [];
    return decision.markers.map((marker) => ({ ...marker, threadId: props.threadId ?? "" }));
  }, [decision, props.threadId]);

  if (session.failure !== null) return <main className="document"><p role="alert">{session.failure.message}</p></main>;
  if (session.loading || session.document === null) return <main className="document"><p className="muted">加载中……</p></main>;

  const note = decision === null ? null : RIGHT_PANE_NOTE[decision.kind];
  const split = ping !== null && baseVersion !== null;

  return (
    <main className="document">
      <header className="document-top">
        <h1>{session.document.name}</h1>
        <span className="readonly-badge">只读 · 内容由 Agent 编辑</span>
      </header>

      <div className={`document-body${split ? " split" : ""}`}>
        {split && (
          <div className="pane-wrapper pane-base">
            <p className="pane-label">基版 v{baseVersion.versionIdx} · 只读</p>
            <ViewHost label="评论所基于的版本" version={baseVersion} markers={leftMarkers} className="pane" />
          </div>
        )}

        <div className="pane-wrapper">
          {note !== null && <p className="pane-note">{note}</p>}
          {session.currentVersion === null
            ? <p className="muted">这件作品还在初始化，暂时没有可读的版本。</p>
            : <ViewHost label="当前版本" version={session.currentVersion} markers={rightMarkers} className="pane pane-current" />}
        </div>

        <ThreadPanel
          threads={session.summary?.threads ?? []}
          currentVersionIdx={session.document.currentVersionIdx}
          selectedThreadId={props.threadId}
          selectedPingIdx={props.pingIdx}
          onSelect={(threadId) => {
            window.location.hash = routeToHash({ kind: "document", documentId: props.documentId, threadId });
          }}
          onSelectPing={(pingIdx) => {
            window.location.hash = routeToHash({
              kind: "document", documentId: props.documentId, threadId: props.threadId ?? "", pingIdx,
            });
          }}
        />
      </div>
    </main>
  );
}
