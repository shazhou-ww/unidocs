import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, FileText, History as HistoryIcon, Link, Lock as LockIcon } from "lucide-react";
import type { SValue } from "@unidocs/protocol-platform";
import type { CommentRecord, DocumentLocation, VersionRecord } from "@unidocs/protocol-tenant-portal";
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useClient } from "../client-context.js";
import { anchorKeyOf, type Draft } from "../drafts/draft-store.js";
import { useDrafts } from "../drafts/use-drafts.js";
import { errorText } from "../error-text.js";
import { decideRightPane, type RightPaneDecision } from "../model/compare.js";
import { sendDraft } from "../model/send-comment.js";
import { useDocumentSession } from "../model/use-document.js";
import { useOperatorFollow } from "../model/use-operator-follow.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { DocumentCrumb, Topbar } from "../shell/app-shell.js";
import type { HostImplementation } from "../view/channel.js";
import type { RoledMarker } from "../view/markers.js";
import { noopHost, ViewHost } from "../view/view-host.js";
import { VersionHistory } from "./version-history.js";
import { documentTypeDisplayName } from "./create-document-form.js";

const RIGHT_PANE_NOTE: Readonly<Record<RightPaneDecision["kind"], string | null>> = {
  "reply-result": null,
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

/** 左栏的基版：version 元信息与 snapshot 正文一起落地，见下面 effect 里的说明。 */
interface BaseVersion {
  readonly version: VersionRecord;
  readonly snapshot: SValue;
}

export function DocumentPage(props: { documentId: string; threadId?: string; commentIdx?: number }) {
  const client = useClient();
  const session = useDocumentSession(props.documentId);
  const drafts = useDrafts(props.documentId);
  // R17：没有版本时等 Operator 写出第一版，发出评论后等它的 reply；等到了就整页 reload。
  const follow = useOperatorFollow({
    documentId: props.documentId,
    awaitingFirstVersion: session.document !== null && session.document.currentVersionIdx === null,
    onProgress: session.reload,
  });
  const [base, setBase] = useState<BaseVersion | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [typeNames, setTypeNames] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    void client.listPublicDocumentTypes().then((page) => {
      if (!cancelled) setTypeNames(Object.fromEntries(page.items.map((type) => [type.documentType, documentTypeDisplayName(type)])));
    }).catch(() => { if (!cancelled) setTypeNames({}); });
    return () => { cancelled = true; };
  }, [client]);

  // 输入框都由动作触发：回复某一处开一份 Composer，「修改」直接压回一份草稿
  // （不经过 Composer——见 editFrom）。composeDraftId 记住当前 Composer 绑定的
  // 草稿，好让 ThreadPanel 把它从草稿块列表里剔掉，不然「发送」按钮会出现两次。
  const [composingThreadId, setComposingThreadId] = useState<string | null>(null);
  const [composeDraftId, setComposeDraftId] = useState<string | null>(null);
  const [composingInitialText, setComposingInitialText] = useState("");
  // 选区「添加评论」在面板里打开的新一处：位置由 View 编码好交过来，还没有 threadId。
  // 与 composingThreadId 共用 composeDraftId/composingInitialText——同一时刻只开一个输入框。
  const [composingNew, setComposingNew] = useState<{ location: DocumentLocation; baseVersionIdx: number } | null>(null);
  const [draftFailures, setDraftFailures] = useState<Readonly<Record<string, string>>>({});

  const selected = session.summary?.threads.find(({ detail }) => detail.threadId === props.threadId) ?? null;
  const comment: CommentRecord | null = selected === null
    ? null
    : (selected.detail.comments.find((candidate) => candidate.commentIdx === props.commentIdx)
      ?? selected.detail.comments[selected.detail.comments.length - 1]
      ?? null);

  // 分屏对照下两栏各自独立加载：左栏基版由 comment.baseVersionIdx 决定，与右栏的 current 请求
  // 相互独立，一旦选中的评论/thread 变化就要重新拉取，并在组件卸载或下一轮请求抢先时取消。
  //
  // version 和它的 snapshot 在同一个 Promise.all 里一起取、一起用同一次 setBase 落地——
  // 不拆成两次 await/两次 setState，就不会出现「新 version 已经落地、旧 snapshot 还没换」
  // 这种两者对不上的中间态，baseReady 的对齐承诺才站得住（见下面 baseReady 的注释）。
  useEffect(() => {
    if (comment === null) { setBase(null); return; }
    let cancelled = false;
    void Promise.all([
      client.getVersion(props.documentId, comment.baseVersionIdx),
      client.getVersionSnapshot(props.documentId, comment.baseVersionIdx),
    ])
      .then(([version, snapshot]) => { if (!cancelled) setBase({ version, snapshot }); })
      .catch(() => { if (!cancelled) setBase(null); });
    return () => { cancelled = true; };
  }, [client, props.documentId, comment?.baseVersionIdx]);

  const currentContent = (session.currentSnapshot as unknown as MarkdownSnapshot | null)?.content ?? "";
  const canDownload = typeof (session.currentSnapshot as unknown as MarkdownSnapshot | null)?.content === "string";
  const currentVersionIdx = session.document?.currentVersionIdx ?? null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setActionNotice("链接已复制");
    } catch {
      setActionNotice("复制失败，请从地址栏复制链接。");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([currentContent], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${session.document?.name ?? "document"}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const decision = useMemo<RightPaneDecision | null>(() => {
    if (comment === null || selected === null) return null;
    return decideRightPane({
      comment,
      replies: selected.detail.replies,
      currentVersionIdx,
      currentContent,
    });
  }, [comment, selected, currentVersionIdx, currentContent]);

  // 跨版本切换评论时，leftMarkers 依赖的 comment 会立刻变，但 base 要等下一轮
  // fetch 回来才跟上（见上面的 effect）。如果不等两者对齐就下发标记，ViewHost 会把
  // 新评论的锚点套在旧版本的正文上，出现一瞬间标错位置、随后才自愈的问题——正是
  // §2.3「点某一条评论切基版」这条路径每次切换都会走到的地方。baseReady 就是那个
  // 对齐点：version（从而它配套的 snapshot）和 markers 一起交给 ViewHost，宁可过渡期
  // 什么都不标，也不要标错——同时也保证了 ViewHost 收到的 snapshot 确实是 base.version
  // 这一版的正文，不是切换前那一版残留的内容。
  const baseReady = base !== null && comment !== null && base.version.versionIdx === comment.baseVersionIdx;

  // Ruling B: decideRightPane 不知道 threadId，markers 里带的是空串；两栏都要在这里补上
  // 真实值，否则渲染出的 mark[data-thread-id] 是空的，将来点高亮反查 thread 会悄悄失效。
  // Ruling C: ViewHost 的 view-sync effect 把 markers 列进依赖数组，这里必须 useMemo
  // 让数组引用稳定，否则父组件每次渲染都会重新触发三次 RPC。
  const leftMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (!baseReady || comment === null || comment.location === null || selected === null) return [];
    return [{
      threadId: props.threadId ?? "",
      commentIdx: comment.commentIdx,
      open: selected.state.open,
      location: comment.location,
      role: "ping" as const,
    }];
  }, [baseReady, comment, selected, props.threadId]);

  const rightMarkers = useMemo<readonly RoledMarker[]>(() => {
    if (decision === null) return [];
    return decision.markers.map((marker) => ({ ...marker, threadId: props.threadId ?? "" }));
  }, [decision, props.threadId]);

  // View 的「添加评论」是唯一能把选区编码成 DocumentLocation 的地方（§3.1）。它只把
  // 位置交过来；输入框在讨论面板里打开，和「回复」是同一个 Composer，发送走下面同一个
  // send——失败不丢字、重试复用同一个 idempotencyKey。
  //
  // carry-forward 2：ViewHost 的挂载 effect 只在挂载时读一次 props.host，这个对象因此
  // 必须引用稳定。它要读的草稿会随渲染变化，所以装进 ref，host 闭包只在被调用时读
  // ref.current；useState 的 setter 本身是稳定的，可以直接用。
  const latest = useRef({ draftsForAnchor: drafts.draftsForAnchor });
  latest.current = { draftsForAnchor: drafts.draftsForAnchor };

  const viewHost: HostImplementation = useMemo(() => ({
    ...noopHost,
    composeComment: async ({ location, baseVersionIdx }) => {
      // 同一处之前写了一半的草稿就接着写，不另起一份。
      const existing = latest.current.draftsForAnchor(anchorKeyOf({ threadId: null, location }))
        .find((draft) => draft.editedFromCommentIdx === null);
      setComposingThreadId(null);
      setComposingNew({ location, baseVersionIdx });
      setComposeDraftId(existing?.draftId ?? null);
      setComposingInitialText(existing?.text ?? "");
    },
  }), []);

  const send = async (draft: Draft) => {
    // 发请求前绑定文档作用域：POST 回来时页面若已卸载或换了文档，就不开始等 reply（见 use-operator-follow.ts）。
    const followReply = follow.bindReplyFollow();
    try {
      const sent = await sendDraft(client, props.documentId, draft);
      drafts.removeDraft(draft.draftId);
      setDraftFailures((previous) => removeKey(previous, draft.draftId));
      // carry-forward 1：reload() 会把 loading 重新置 true，但下面的早退已经改成
      // 只在“还没有任何内容”时才整页早退，所以这次刷新不会把已经渲染的面板闪掉。
      session.reload();
      followReply(sent.threadId, sent.commentIdx);
    } catch (cause) {
      // 失败一律保留草稿，复用原 idempotencyKey 重试——永远不丢用户写的字。
      setDraftFailures((previous) => ({ ...previous, [draft.draftId]: errorText(cause) }));
    }
  };

  const onComposeOpen = (threadId: string) => {
    const anchorKey = anchorKeyOf({ threadId, location: null });
    // 回到之前写了一半就切走的那份草稿，而不是每次打开都另起一份。
    const existing = drafts.draftsForAnchor(anchorKey).find((draft) => draft.editedFromCommentIdx === null);
    setComposingNew(null);
    setComposingThreadId(threadId);
    setComposeDraftId(existing?.draftId ?? null);
    setComposingInitialText(existing?.text ?? "");
  };

  const composeBaseVersionIdx = (threadId: string): number => {
    const thread = session.summary?.threads.find((candidate) => candidate.detail.threadId === threadId);
    return session.document?.currentVersionIdx ?? thread?.detail.comments[0]?.baseVersionIdx ?? 0;
  };

  const composeLocation = (threadId: string) => {
    const thread = session.summary?.threads.find((candidate) => candidate.detail.threadId === threadId);
    return thread?.detail.comments[0]?.location ?? null;
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

  const onNewComposeChange = (text: string) => {
    if (composingNew === null) return;
    const draft = drafts.saveDraft({
      draftId: composeDraftId ?? undefined,
      threadId: null,
      location: composingNew.location,
      baseVersionIdx: composingNew.baseVersionIdx,
      text,
    });
    setComposeDraftId(draft.draftId);
  };

  const onNewComposeSend = (text: string) => {
    if (composingNew === null) return;
    const draft = drafts.saveDraft({
      draftId: composeDraftId ?? undefined,
      threadId: null,
      location: composingNew.location,
      baseVersionIdx: composingNew.baseVersionIdx,
      text,
    });
    // 同回复：发送即收起；失败时这份草稿作为「新的一处」草稿块带着错误和「重试」出现。
    setComposingNew(null);
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
    setComposingNew(null);
    setComposeDraftId(null);
  };

  const onComposeBlurAway = () => {
    setComposingThreadId(null);
    setComposingNew(null);
    setComposeDraftId(null);
  };

  const onSendDraft = (draft: Draft) => void send(draft);

  const onDiscardDraft = (draftId: string) => {
    drafts.removeDraft(draftId);
    setDraftFailures((previous) => removeKey(previous, draftId));
    if (composeDraftId === draftId) { setComposingThreadId(null); setComposingNew(null); setComposeDraftId(null); }
  };

  const onEditFromComment = (threadId: string, editComment: CommentRecord) => {
    const anchorKey = anchorKeyOf({ threadId, location: null });
    // 重复点「修改」复用同一份草稿，不会每点一次就多一份。
    const existing = drafts.draftsForAnchor(anchorKey)
      .find((draft) => draft.editedFromCommentIdx === editComment.commentIdx);
    const draft = drafts.saveDraft({
      draftId: existing?.draftId,
      threadId,
      location: editComment.location,
      // 新草稿基于 current，不是原评论的基版——这是一条关于用户此刻看到的版本的新评论。
      baseVersionIdx: session.document?.currentVersionIdx ?? editComment.baseVersionIdx,
      text: editComment.content.text ?? "",
      editedFromCommentIdx: editComment.commentIdx,
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
    if (session.failure !== null) return <section className="document empty"><p role="alert">{session.failure.message}</p><button type="button" onClick={session.reload}>重新加载文档</button></section>;
    return <main className="document"><p className="muted">加载中……</p></main>;
  }

  const note = decision === null ? null : RIGHT_PANE_NOTE[decision.kind];
  const split = comment !== null && base !== null;

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
          {follow.waitingForReply && <span className="refreshing-badge" aria-live="polite">等待 Operator 回复…</span>}
          <button type="button" className="icon ghost" title="复制链接" aria-label="复制链接" onClick={() => void copyLink()}><Link size={14} aria-hidden="true" /></button>
          {currentVersionIdx !== null && canDownload && !historyOpen && <button type="button" className="icon ghost" title="下载 Markdown" aria-label="下载 Markdown" onClick={download}><Download size={14} aria-hidden="true" /></button>}
          {currentVersionIdx !== null && !historyOpen && <button type="button" aria-label="版本历史" onClick={() => { onComposeBlurAway(); setHistoryOpen(true); }}><HistoryIcon size={14} aria-hidden="true" />v{currentVersionIdx}</button>}
        </div>
      </Topbar>

      <div className="doc-header">
        <h1 className="doc-title">{session.document.name}</h1>
        <div className="doc-subtitle">
          <span className="row" style={{ gap: 4 }}><FileText size={12} aria-hidden="true" />{typeNames[session.document.documentType] ?? session.document.documentType}</span>
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
      {follow.notice !== null && <p role="status" className="operator-wait-banner">{follow.notice}</p>}
      {actionNotice !== null && <p role="status" className="operator-wait-banner">{actionNotice}</p>}
      {split && !historyOpen && <div className="comparison-toolbar"><span>版本对照</span><button type="button" onClick={() => { onComposeBlurAway(); window.location.hash = routeToHash({ kind: "document", documentId: props.documentId }); }}><ArrowLeft size={14} aria-hidden="true" />返回当前版本</button></div>}

      {historyOpen && currentVersionIdx !== null ? <VersionHistory
        key={props.documentId}
        documentId={props.documentId}
        currentVersionIdx={currentVersionIdx}
        onClose={() => setHistoryOpen(false)}
        onMoved={() => { setHistoryOpen(false); session.reload(); }}
        onRefresh={session.reload}
      /> : <div className={`doc-workspace${split ? " compare" : ""}`}>
        <section className="content-area">
          {split && (
            <div className="pane-wrapper pane-base">
              <p className="pane-label">
                <HistoryIcon size={11} aria-hidden="true" />
                基版 v{base.version.versionIdx} · 只读
              </p>
              <ViewHost
                // 问题 3：文档切换（同一路由 kind，比如从一篇的「Agent 最新回复」条跳到
                // 另一篇）不会重新挂载 DocumentPage，ViewHost 内部通道却是挂载时建一次
                // 就不再变（carry-forward 2）。用带 documentId 的 key 强制在文档变化时
                // 重建，不然通道会一直绑定在旧文档上。
                key={`${props.documentId}:base`}
                label="评论所基于的版本"
                version={base.version}
                snapshot={base.snapshot}
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
              // 设计文档 §5.4：首版本产生前不能创建 thread 或追加 comment——这里没有
              // ViewHost 可挂（下面 else 分支才有），"添加评论" 的触发器根本不会装上，
              // 前端也就不会发出注定 404 的写请求。
              ? <p className="muted">这件作品还在等待 Operator 初始化，暂时没有可读的版本，也还不能评论。</p>
              : (
                <ViewHost
                  key={`${props.documentId}:current`}
                  label="当前版本"
                  version={session.currentVersion}
                  snapshot={session.currentSnapshot}
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
          selectedCommentIdx={props.commentIdx}
          onSelect={(threadId) => {
            onComposeBlurAway();
            window.location.hash = routeToHash({ kind: "document", documentId: props.documentId, threadId: threadId === props.threadId ? undefined : threadId });
          }}
          onSelectComment={(commentIdx) => {
            window.location.hash = routeToHash({
              kind: "document", documentId: props.documentId, threadId: props.threadId ?? "", commentIdx,
            });
          }}
          draftsForAnchor={drafts.draftsForAnchor}
          draftCount={drafts.count}
          orphanedDrafts={drafts.drafts.filter((draft) => draft.threadId === null)}
          composingThreadId={composingThreadId}
          composingNew={composingNew}
          composeDraftId={composeDraftId}
          composingInitialText={composingInitialText}
          draftFailures={draftFailures}
          onComposeOpen={onComposeOpen}
          onComposeChange={onComposeChange}
          onNewComposeChange={onNewComposeChange}
          onNewComposeSend={onNewComposeSend}
          onComposeSend={onComposeSend}
          onComposeCancel={onComposeCancel}
          onComposeBlurAway={onComposeBlurAway}
          onSendDraft={onSendDraft}
          onDiscardDraft={onDiscardDraft}
          onEditFromComment={onEditFromComment}
        />
      </div>}
    </>
  );
}
