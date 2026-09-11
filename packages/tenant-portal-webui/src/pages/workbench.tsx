import { useEffect, useMemo, useState } from "react";
import type { DocumentRecord } from "@unidocs/protocol-platform";
import { useClient } from "../client-context.js";
import { createDraftStore } from "../drafts/draft-store.js";
import { loadDiscussionSummary, type DiscussionSummary } from "../model/discussion-summary.js";
import { routeToHash } from "../router.js";
import "./workbench.css";

interface Entry {
  readonly document: DocumentRecord;
  readonly summary: DiscussionSummary;
}

function discussionLabel(summary: DiscussionSummary): string {
  if (summary.threads.length === 0) return "暂无讨论";
  const parts: string[] = [];
  if (summary.openCount > 0) parts.push(`${summary.openCount} 处待回复`);
  if (summary.answeredCount > 0) parts.push(`Agent 已回复 ${summary.answeredCount} 处`);
  return parts.join(" · ");
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
        const loaded = await Promise.all(page.items.map(async (document) => ({
          document,
          summary: await loadDiscussionSummary(client, document.documentId),
        })));
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
    return entries.filter((entry) => entry.document.name.includes(needle));
  }, [entries, keyword]);

  const latest = useMemo(
    () => entries?.flatMap((entry) => entry.summary.latestPong === null
      ? []
      : [{ document: entry.document, pong: entry.summary.latestPong }]) ?? [],
    [entries],
  );

  return (
    <main className="workbench">
      <header className="workbench-head">
        <h1>我的作品</h1>
        <input
          type="search"
          aria-label="搜索作品"
          placeholder="搜索标题"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </header>

      <section className="agent-strip" role="status" aria-label="Agent 最新回复">
        <h2>Agent 最新回复</h2>
        <p className="agent-strip-note">回复只表示 Agent 已处理，不表示你已接受。不同意就在原处追加一条评论。</p>
        {latest.length === 0
          ? <p className="muted">还没有回复。</p>
          : (
            <ul>
              {latest.map(({ document, pong }) => (
                <li key={document.documentId}>
                  <a
                    href={routeToHash({ kind: "document", documentId: document.documentId, threadId: pong.threadId })}
                    aria-label={`${document.name} — 打开 Agent 回复的这一处`}
                  >
                    {document.name}
                  </a>
                  <span className={pong.isPlain ? "pong-plain" : "pong-versioned"}>{pong.text}</span>
                </li>
              ))}
            </ul>
          )}
      </section>

      {failure !== null && <p role="alert">加载失败：{failure}</p>}
      {visible === null && failure === null && <p className="muted">加载中……</p>}
      {visible !== null && visible.length === 0 && <p className="muted">还没有作品</p>}

      <ul className="document-grid" aria-label="作品">
        {(visible ?? []).map((entry) => (
          <li key={entry.document.documentId}>
            <article>
              <a href={routeToHash({ kind: "document", documentId: entry.document.documentId })}>
                {entry.document.name}
              </a>
              <footer>
                {discussionLabel(entry.summary)}
                {draftStore.countForDocument(entry.document.documentId) > 0 && (
                  <span className="draft-count">{draftStore.countForDocument(entry.document.documentId)} 条未发送</span>
                )}
              </footer>
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
