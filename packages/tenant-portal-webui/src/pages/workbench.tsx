/**
 * 我的作品。结构对齐 docs/design/unidocs-mock.js 的 renderHome()：
 * topbar/breadcrumb → .home-intro → .filters → .doc-grid，卡片以内容缩略图为主视觉。
 *
 * 与设计稿的差异，都是因为对应能力还没有进 tenant 协议，宁可不渲染也不伪造：
 * tag 筛选、作者与更新时间都不出现。
 */
import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Bot, LayoutGrid, List, Plus, Search } from "lucide-react";
import type { DocumentRecord } from "@unidocs/protocol-tenant-portal";
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useClient, useDraftScope } from "../client-context.js";
import { createDraftStore } from "../drafts/draft-store.js";
import { errorText } from "../error-text.js";
import { loadDiscussionSummary, type DiscussionSummary } from "../model/discussion-summary.js";
import { routeToHash } from "../router.js";
import { PrivacyNote, Topbar, WorkspaceCrumb } from "../shell/app-shell.js";
import { CreateDocumentForm, documentTypeDisplayName } from "./create-document-form.js";

interface Entry {
  readonly document: DocumentRecord;
  readonly summary: DiscussionSummary;
  readonly content: string;
}

function discussionLabel(summary: DiscussionSummary): string {
  if (summary.threads.length === 0) return "暂无讨论";
  const parts: string[] = [];
  if (summary.openCount > 0) parts.push(`${summary.openCount} 处待回复`);
  if (summary.answeredCount > 0) parts.push(`Agent 已回复 ${summary.answeredCount} 处`);
  return parts.join(" · ");
}

/** 缩略图用的正文 HTML，和设计稿一样直接渲染内容本身，不另做占位图。 */
function thumbnailHtml(content: string): string {
  if (content === "") return "";
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string, { FORBID_TAGS: ["a"] });
}

function excerpt(content: string, length = 65): string {
  const text = content.replace(/^#+\s.*$/gm, "").replace(/[*_`>[\]()#-]/g, "");
  return text.trim().replace(/\s+/g, " ").slice(0, length);
}

export function WorkbenchPage(props: { onDocumentCount?(count: number): void } = {}) {
  const client = useClient();
  const scope = useDraftScope();
  const draftStore = useMemo(
    () => createDraftStore(globalThis.localStorage, scope),
    [scope.tenantId, scope.principalId],
  );
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeType, setActiveType] = useState("");
  const [sort, setSort] = useState("recent");
  const [layout, setLayout] = useState("grid");
  const [epoch, setEpoch] = useState(0);
  const [typeNames, setTypeNames] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    void client.listPublicDocumentTypes().then((page) => {
      if (!cancelled) setTypeNames(Object.fromEntries(page.items.map((type) => [type.documentType, documentTypeDisplayName(type)])));
    }).catch(() => { if (!cancelled) setTypeNames({}); });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void (async () => {
      try {
        const documents: DocumentRecord[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listDocuments({ cursor });
          if (cancelled) return;
          documents.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        const loaded = await Promise.all(documents.map(async (document) => {
          const summary = await loadDiscussionSummary(client, document.documentId);
          let content = "";
          if (document.currentVersionIdx !== null) {
            const snapshot = await client.getVersionSnapshot(document.documentId, document.currentVersionIdx);
            content = (snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";
          }
          return { document, summary, content };
        }));
        if (!cancelled) { setEntries(loaded); props.onDocumentCount?.(loaded.length); }
      } catch (cause) {
        if (!cancelled) setFailure(errorText(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [client, epoch, props.onDocumentCount]);

  const visible = useMemo(() => {
    if (entries === null) return null;
    const needle = keyword.trim().toLocaleLowerCase();
    return entries.filter((entry) => (!activeType || entry.document.documentType === activeType)
      && `${entry.document.name} ${entry.content}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => sort === "title"
        ? left.document.name.localeCompare(right.document.name, "zh-CN")
        : right.document.createdAt.localeCompare(left.document.createdAt));
  }, [entries, keyword, activeType, sort]);

  const latest = useMemo(
    () => entries?.flatMap((entry) => entry.summary.latestReply === null
      ? []
      : [{ document: entry.document, reply: entry.summary.latestReply }]) ?? [],
    [entries],
  );

  return (
    <>
      <Topbar><WorkspaceCrumb /><PrivacyNote /></Topbar>

      <section className="home">
        <div className="row spread home-intro">
          <div>
            <div className="eyebrow">
              WORKSPACE / {String(entries?.length ?? 0).padStart(2, "0")}
            </div>
            <h1>我的作品</h1>
            <p>想法、草稿，以及持续生长的作品。内容由 Agent 编辑，你留下评论。</p>
          </div>
          {!creating && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden="true" />新建文档
            </button>
          )}
        </div>

        {creating && <CreateDocumentForm onCancel={() => setCreating(false)} />}

        <section className="banner agent-strip" role="status" aria-label="Agent 最新回复">
          <div className="row" style={{ gap: 6 }}>
            <Bot size={14} aria-hidden="true" />
            <strong>Agent 最新回复</strong>
          </div>
          <p className="agent-strip-note muted">
            回复只表示 Agent 已处理，不表示你已接受。不同意就在原处追加一条评论。
          </p>
          {latest.length === 0
            ? <p className="muted">还没有回复。</p>
            : (
              <ul className="list">
                {latest.map(({ document, reply }) => (
                  <li key={document.documentId} className="row" style={{ gap: 10 }}>
                    <a
                      href={routeToHash({ kind: "document", documentId: document.documentId, threadId: reply.threadId })}
                      aria-label={`${document.name} — 打开 Agent 回复的这一处`}
                    >
                      {document.name}
                    </a>
                    <span className={reply.isPlain ? "pong-plain muted" : "pong-versioned"}>{reply.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <div className="filters">
          <div className="filter-query">
            <label className="search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索作品"
                placeholder="搜索标题或正文…"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <select aria-label="按类型筛选" value={activeType} onChange={(event) => setActiveType(event.target.value)}>
              <option value="">所有类型</option>
              {[...new Set(entries?.map((entry) => entry.document.documentType) ?? [])].map((type) => <option key={type} value={type}>{typeNames[type] ?? type}</option>)}
            </select>
          </div>
          <select aria-label="作品排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">最近创建</option><option value="title">标题排序</option></select>
          <div className="grow" />
          <div className="segmented" role="group" aria-label="展示方式">
            <button type="button" className={`icon${layout === "grid" ? " active" : ""}`} title="网格视图" aria-label="网格视图" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><LayoutGrid size={15} aria-hidden="true" /></button>
            <button type="button" className={`icon${layout === "list" ? " active" : ""}`} title="列表视图" aria-label="列表视图" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><List size={15} aria-hidden="true" /></button>
          </div>
        </div>

        {failure !== null && <div className="empty"><p role="alert">加载失败：{failure}</p><button type="button" onClick={() => setEpoch((value) => value + 1)}>重新加载作品</button></div>}
        {visible === null && failure === null && <p className="muted">加载中……</p>}

        <div className="section-label">
          <span>{visible === null ? "" : `${visible.length} 件作品`}</span>
        </div>

        {visible !== null && visible.length === 0 && <div className="empty">
          {entries?.length === 0 ? "还没有作品" : <><p>没有匹配的作品</p><button type="button" onClick={() => { setKeyword(""); setActiveType(""); }}>清除筛选</button></>}
        </div>}

        <ul className={`doc-grid${layout === "list" ? " list" : ""}`} aria-label="作品">
          {(visible ?? []).map((entry) => {
            const drafts = draftStore.countForDocument(entry.document.documentId);
            return (
              <li key={entry.document.documentId}>
                <article className="doc-card">
                  <a
                    className="card-link"
                    href={routeToHash({ kind: "document", documentId: entry.document.documentId })}
                  >
                    <div className="doc-thumb" aria-hidden="true">
                      <div
                        className="mini-paper"
                        dangerouslySetInnerHTML={{ __html: thumbnailHtml(entry.content) }}
                      />
                    </div>
                    <div className="doc-info">
                      <h2>{entry.document.name}</h2>
                      <div className="description">{excerpt(entry.content)}</div>
                      <div className="row" style={{ gap: 5, marginBottom: 12 }}>
                        <span className="tag doc-type">{typeNames[entry.document.documentType] ?? entry.document.documentType}</span>
                        <span className="muted">{entry.document.currentVersionIdx === null ? "初始化中" : `v${entry.document.currentVersionIdx}`}</span>
                      </div>
                      <div className="row spread card-meta">
                        <span>{discussionLabel(entry.summary)}</span>
                        {drafts > 0 && <span className="draft-count">{drafts} 条未发送</span>}
                      </div>
                    </div>
                  </a>
                </article>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
