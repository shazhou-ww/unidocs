/**
 * 我的作品。结构对齐 docs/design/unidocs-mock.js 的 renderHome()：
 * topbar/breadcrumb → .home-intro → .filters → .doc-grid，卡片以内容缩略图为主视觉。
 *
 * 与设计稿的差异，都是因为对应能力还没有进 tenant 协议，宁可不渲染也不伪造：
 * tag 筛选、排序、网格/列表切换、作者与更新时间都不出现。
 */
import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Bot, Search } from "lucide-react";
import type { DocumentRecord } from "@unidocs/protocol-platform";
import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useClient } from "../client-context.js";
import { createDraftStore } from "../drafts/draft-store.js";
import { loadDiscussionSummary, type DiscussionSummary } from "../model/discussion-summary.js";
import { routeToHash } from "../router.js";
import { PrivacyNote, Topbar, WorkspaceCrumb } from "../shell/app-shell.js";

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
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
}

function excerpt(content: string, length = 65): string {
  const text = content.replace(/^#+\s.*$/gm, "").replace(/[*_`>[\]()#-]/g, "");
  return text.trim().replace(/\s+/g, " ").slice(0, length);
}

export function WorkbenchPage() {
  const client = useClient();
  const draftStore = useMemo(() => createDraftStore(globalThis.localStorage), []);
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await client.listDocuments();
        const loaded = await Promise.all(page.items.map(async (document) => {
          const summary = await loadDiscussionSummary(client, document.documentId);
          let content = "";
          if (document.currentVersionIdx !== null) {
            const version = await client.getVersion(document.documentId, document.currentVersionIdx);
            content = (version.snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";
          }
          return { document, summary, content };
        }));
        if (!cancelled) setEntries(loaded);
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : "加载失败");
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const visible = useMemo(() => {
    if (entries === null) return null;
    const needle = keyword.trim();
    if (needle === "") return entries;
    return entries.filter((entry) => entry.document.name.includes(needle) || entry.content.includes(needle));
  }, [entries, keyword]);

  const latest = useMemo(
    () => entries?.flatMap((entry) => entry.summary.latestPong === null
      ? []
      : [{ document: entry.document, pong: entry.summary.latestPong }]) ?? [],
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
        </div>

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
                {latest.map(({ document, pong }) => (
                  <li key={document.documentId} className="row" style={{ gap: 10 }}>
                    <a
                      href={routeToHash({ kind: "document", documentId: document.documentId, threadId: pong.threadId })}
                      aria-label={`${document.name} — 打开 Agent 回复的这一处`}
                    >
                      {document.name}
                    </a>
                    <span className={pong.isPlain ? "pong-plain muted" : "pong-versioned"}>{pong.text}</span>
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
          </div>
          <div className="grow" />
        </div>

        {failure !== null && <p role="alert" className="empty">加载失败：{failure}</p>}
        {visible === null && failure === null && <p className="muted">加载中……</p>}

        <div className="section-label">
          <span>{visible === null ? "" : `${visible.length} 件作品`}</span>
        </div>

        {visible !== null && visible.length === 0 && <div className="empty">还没有作品</div>}

        <ul className="doc-grid" aria-label="作品">
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
                        <span className="tag doc-type">MD</span>
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
