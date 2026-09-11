import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, History as HistoryIcon, Lock as LockIcon } from "lucide-react";
import type { PingRecord, VersionRecord } from "@unidocs/protocol-platform";
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useClient } from "../client-context.js";
import { anchorKeyOf, type Draft } from "../drafts/draft-store.js";
import { useDrafts } from "../drafts/use-drafts.js";
import { errorText } from "../error-text.js";
import { decideRightPane, type RightPaneDecision } from "../model/compare.js";
import { createThreadFromView } from "../model/create-thread-from-view.js";
import { sendDraft } from "../model/send-comment.js";
import { useDocumentSession } from "../model/use-document.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { DocumentCrumb, Topbar } from "../shell/app-shell.js";
import type { HostImplementation } from "../view/channel.js";
import type { RoledMarker } from "../view/markers.js";
import { noopHost, ViewHost } from "../view/view-host.js";

const RIGHT_PANE_NOTE: Readonly<Record<RightPaneDecision["kind"], string | null>> = {
  "pong-result": null,
  "same-version": "暂无改动 · 与左栏同一版本",
  "stale-present": "这段内容还在，但这不是 Agent 的改动——常见成因是它处理别的一处评论时顺带改动了附近内容。",
  "stale-rewritten": "这段内容已经不在当前版本里。平台不做语义迁移，这条评论依然有效，由 Agent 判断它是否仍然适用；常见成因是它处理别的一处评论时顺带改动了这里。",
  // 这条评论的位置类型不是当前 host 能判断的 Markdown 文本区间（比如未来的 PSD 位置）。
  // 不能顺着「内容已不在当前版本里」的说法去猜——那是在没有证据时做出断言，宁可诚实地
  // 说「看不出来」，也不能给用户一个可能是错的结论（见 model/compare.ts 的判定与 spec §11）。
  "unsupported-location": "这条评论使用的位置类型，当前视图还判断不出它是否仍然适用。",
};

function removeKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  const client = useClient();
  const session = useDocumentSession(props.documentId);
  const drafts = useDrafts(props.documentId);
  const [baseVersion, setBaseVersion] = useState<VersionRecord | null>(null);

  // 输入框都由动作触发：回复某一处开一份 Composer，「修改」直接压回一份草稿
  // （不经过 Composer——见 editFrom）。composeDraftId 记住当前 Composer 绑定的
  // 草稿，好让 ThreadPanel 把它从草稿块列表里剔掉，不然「发送」按钮会出现两次。
  const [composingThreadId, setComposingThreadId] = useState<string | null>(null);
  const [composeDraftId, setComposeDraftId] = useState<string | null>(null);
  const [composingInitialText, setComposingInitialText] = useState("");
  const [draftFailures, setDraftFailures] = useState<Readonly<Record<string, string>>>({});

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

  // 跨版本切换评论时，leftMarkers 依赖的 ping 会立刻变，但 baseVersion 要等下一轮
  // fetch 回来才跟上（见上面的 effect）。如果不等两者对齐就下发标记，ViewHost 会把
  // 新评论的锚点套在旧版本的正文上，出现一瞬间标错位置、随后才自愈的问题——正是
  // §2.3「点某一条评论切基版」这条路径每次切换都会走到的地方。baseReady 就是那个
  // 对齐点：version 和 markers 一起交给 ViewHost，宁可过渡期什么都不标，也不要标错。
  const baseReady = baseVersion !== null && ping !== null && baseVersion.versionIdx === ping.baseVersionIdx;

  // Ruling B: decideRightPane 不知道 threadId，markers 里带的是空串；两栏都要在这里补上
  // 真实值，否则渲染出的 mark[data-thread-id] 是空的，将来点高亮反查 thread 会悄悄失效。
  // Ruling C: ViewHost 的 view-sync effect 把 markers 列进依赖数组，这里必须 useMemo
  // 让数组引用稳定，否则父组件每次渲染都会重新触发三次 RPC。
  const leftMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (!baseReady || ping === null || ping.location === null || selected === null) return [];
    return [{
      threadId: props.threadId ?? "",
      pingIdx: ping.pingIdx,
      open: selected.state.open,
      location: ping.location,
      role: "ping" as const,
    }];
  }, [baseReady, ping, selected, props.threadId]);

  const rightMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (decision === null) return [];
    return decision.markers.map((marker) => ({ ...marker, threadId: props.threadId ?? "" }));
  }, [decision, props.threadId]);

  // View 的「添加评论」是唯一能把选区编码成 DocumentLocation 的地方（§3.1），
  // 所以要给它一个能真的建 thread 的 host——而且这个 host 必须和其它发送路径
  // 同样安全：失败不丢字、重试复用同一个 idempotencyKey（走 createThreadFromView，
  // 它把草稿系统包了进去，不再直连 client）。
  //
  // carry-forward 2：ViewHost 的挂载 effect 只在挂载时读一次 props.host，这个
  // 对象因此必须引用稳定。但它要用到的 client/currentVersionIdx/saveDraft/
  // removeDraft/reload 这些值会随渲染变化——放进 useMemo 依赖会让引用又变得不
  // 稳定。做法是用一个 ref 装这些易变值，每次渲染都更新它，而 memo 化的 host
  // 闭包只在被调用的那一刻读 ref.current，从不把它们列进依赖数组。
  const latest = useRef({
    client,
    draftsForAnchor: drafts.draftsForAnchor,
    saveDraft: drafts.saveDraft,
    removeDraft: drafts.removeDraft,
    reload: session.reload,
  });
  latest.current = {
    client,
    draftsForAnchor: drafts.draftsForAnchor,
    saveDraft: drafts.saveDraft,
    removeDraft: drafts.removeDraft,
    reload: session.reload,
  };

  const viewHost: HostImplementation = useMemo(() => ({
    ...noopHost,
    createThread: (request) => createThreadFromView({
      client: latest.current.client,
      documentId: props.documentId,
      draftsForAnchor: latest.current.draftsForAnchor,
      saveDraft: latest.current.saveDraft,
      removeDraft: latest.current.removeDraft,
      onSent: latest.current.reload,
    }, request),
  }), [props.documentId]);

  const send = async (draft: Draft) => {
    try {
      await sendDraft(client, props.documentId, draft);
      drafts.removeDraft(draft.draftId);
      setDraftFailures((previous) => removeKey(previous, draft.draftId));
      // carry-forward 1：reload() 会把 loading 重新置 true，但下面的早退已经改成
      // 只在“还没有任何内容”时才整页早退，所以这次刷新不会把已经渲染的面板闪掉。
      session.reload();
    } catch (cause) {
      // 失败一律保留草稿，复用原 idempotencyKey 重试——永远不丢用户写的字。
      setDraftFailures((previous) => ({ ...previous, [draft.draftId]: errorText(cause) }));
    }
  };

  const onComposeOpen = (threadId: string) => {
    const anchorKey = anchorKeyOf({ threadId, location: null });
    // 回到之前写了一半就切走的那份草稿，而不是每次打开都另起一份。
    const existing = drafts.draftsForAnchor(anchorKey).find((draft) => draft.editedFromPingIdx === null);
    setComposingThreadId(threadId);
    setComposeDraftId(existing?.draftId ?? null);
    setComposingInitialText(existing?.text ?? "");
  };

  const composeBaseVersionIdx = (threadId: string): number => {
    const thread = session.summary?.threads.find((candidate) => candidate.detail.threadId === threadId);
    return session.document?.currentVersionIdx ?? thread?.detail.pings[0]?.baseVersionIdx ?? 0;
  };

  const composeLocation = (threadId: string) => {
    const thread = session.summary?.threads.find((candidate) => candidate.detail.threadId === threadId);
    return thread?.detail.pings[0]?.location ?? null;
  };

  const onComposeChange = (threadId: string, text: string) => {
    const draft = drafts.saveDraft({
      draftId: composeDraftId ?? undefined,
      threadId,
      location: composeLocation(threadId),
      baseVersionIdx: composeBaseVersionIdx(threadId),
      text,
    });
    setComposeDraftId(draft.draftId);
  };

  const onComposeSend = (threadId: string, text: string) => {
    const draft = drafts.saveDraft({
      draftId: composeDraftId ?? undefined,
      threadId,
      location: composeLocation(threadId),
      baseVersionIdx: composeBaseVersionIdx(threadId),
      text,
    });
    // 发送这个动作本身就收起输入框：成功了草稿会被移除，失败了它会作为草稿块
    // 带着错误说明和「重试」重新出现——重试走 DraftBlock，复用同一个 draftId、
    // 同一个 idempotencyKey，不会因为还停留在 Composer 里而被排除渲染。
    setComposingThreadId(null);
    setComposeDraftId(null);
    void send(draft);
  };

  const onComposeCancel = () => {
    // 明确点「取消」＝放弃这次输入；和「切去看别处」（onComposeBlurAway）不同，
    // 那种情况要保留草稿。
    if (composeDraftId !== null) {
      drafts.removeDraft(composeDraftId);
      setDraftFailures((previous) => removeKey(previous, composeDraftId));
    }
    setComposingThreadId(null);
    setComposeDraftId(null);
  };

  const onComposeBlurAway = () => {
    setComposingThreadId(null);
    setComposeDraftId(null);
  };

  const onSendDraft = (draft: Draft) => void send(draft);

  const onDiscardDraft = (draftId: string) => {
    drafts.removeDraft(draftId);
    setDraftFailures((previous) => removeKey(previous, draftId));
    if (composeDraftId === draftId) { setComposingThreadId(null); setComposeDraftId(null); }
  };

  const onEditFromPing = (threadId: string, editPing: PingRecord) => {
    const anchorKey = anchorKeyOf({ threadId, location: null });
    // 重复点「修改」复用同一份草稿，不会每点一次就多一份。
    const existing = drafts.draftsForAnchor(anchorKey)
      .find((draft) => draft.editedFromPingIdx === editPing.pingIdx);
    const draft = drafts.saveDraft({
      draftId: existing?.draftId,
      threadId,
      location: editPing.location,
      // 新草稿基于 current，不是原评论的基版——这是一条关于用户此刻看到的版本的新评论。
      baseVersionIdx: session.document?.currentVersionIdx ?? editPing.baseVersionIdx,
      text: editPing.content.text ?? "",
      editedFromPingIdx: editPing.pingIdx,
    });
    setDraftFailures((previous) => removeKey(previous, draft.draftId));
  };

  // carry-forward 1：只有在“还没有任何内容可看”时才整页早退（首次加载 / 加载失败且
  // 从未成功过）。一旦 document 已经取到过，之后每一次 reload()（例如发送评论后）
  // 都继续渲染已有内容，即使这次 reload 本身失败了也一样——use-document.ts 的
  // catch 分支不再把 document/currentVersion/summary 清空，只记下 failure，
  // 交给下面渲染的横幅去提示；不能把已经画出来的面板、分屏、只读徽标、还开着的
  // Composer 全部闪没再重新挂载一遍。session.document === null 时才是真的没有
  // 旧内容可以保留，只能整页显示错误。
  if (session.document === null) {
    if (session.failure !== null) return <main className="document"><p role="alert">{session.failure.message}</p></main>;
    return <main className="document"><p className="muted">加载中……</p></main>;
  }

  const note = decision === null ? null : RIGHT_PANE_NOTE[decision.kind];
  const split = ping !== null && baseVersion !== null;

  return (
    <>
      <Topbar>
        <DocumentCrumb title={session.document.name} />
        <div className="row" style={{ gap: 8 }}>
          <span className="readonly-badge">
            <LockIcon size={11} aria-hidden="true" />
            只读 · 内容由 Agent 编辑
          </span>
          {session.loading && <span className="refreshing-badge" aria-live="polite">正在刷新…</span>}
        </div>
      </Topbar>

      <div className="doc-header">
        <h1 className="doc-title">{session.document.name}</h1>
        <div className="doc-subtitle">
          <span className="row" style={{ gap: 4 }}><FileText size={12} aria-hidden="true" />Markdown</span>
          <span>·</span>
          <span>
            {session.document.currentVersionIdx === null
              ? "初始化中"
              : `当前 v${session.document.currentVersionIdx}`}
          </span>
          <span>·</span>
          <span>内容由 Agent 编辑，你的产出是评论</span>
        </div>
      </div>

      {/* 已经有内容可看时，一次刷新失败（比如发完评论后紧跟的那次 reload() 网络抖了一下）
          不清空已有内容——只给一条不破坏页面的提示，document 仍是上一次成功加载的那一份。
          首次加载失败没有旧内容可留，走的是上面 session.document === null 的整页早退。 */}
      {session.failure !== null && (
        <p role="alert" className="reload-error-banner">刷新失败：{session.failure.message}</p>
      )}

      <div className={`doc-workspace${split ? " compare" : ""}`}>
        <section className="content-area">
          {split && (
            <div className="pane-wrapper pane-base">
              <p className="pane-label">
                <HistoryIcon size={11} aria-hidden="true" />
                基版 v{baseVersion.versionIdx} · 只读
              </p>
              <ViewHost
                // 问题 3：文档切换（同一路由 kind，比如从一篇的「Agent 最新回复」条跳到
                // 另一篇）不会重新挂载 DocumentPage，ViewHost 内部通道却是挂载时建一次
                // 就不再变（carry-forward 2）。用带 documentId 的 key 强制在文档变化时
                // 重建，不然通道会一直绑定在旧文档上。
                key={`${props.documentId}:base`}
                label="评论所基于的版本"
                version={baseVersion}
                markers={leftMarkers}
                className="pane prose"
                commentable={false}
              />
            </div>
          )}

          <div className="pane-wrapper">
            {split && <p className="pane-label">当前版本</p>}
            {note !== null && <p className="pane-note">{note}</p>}
            {session.currentVersion === null
              ? <p className="muted">这件作品还在初始化，暂时没有可读的版本。</p>
              : (
                <ViewHost
                  key={`${props.documentId}:current`}
                  label="当前版本"
                  version={session.currentVersion}
                  markers={rightMarkers}
                  className="pane pane-current prose"
                  host={viewHost}
                />
              )}
          </div>
        </section>

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
          draftsForAnchor={drafts.draftsForAnchor}
          draftCount={drafts.count}
          orphanedDrafts={drafts.drafts.filter((draft) => draft.threadId === null)}
          composingThreadId={composingThreadId}
          composeDraftId={composeDraftId}
          composingInitialText={composingInitialText}
          draftFailures={draftFailures}
          onComposeOpen={onComposeOpen}
          onComposeChange={onComposeChange}
          onComposeSend={onComposeSend}
          onComposeCancel={onComposeCancel}
          onComposeBlurAway={onComposeBlurAway}
          onSendDraft={onSendDraft}
          onDiscardDraft={onDiscardDraft}
          onEditFromPing={onEditFromPing}
        />
      </div>
    </>
  );
}
