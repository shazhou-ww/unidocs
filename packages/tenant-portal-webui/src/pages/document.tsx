import type { MarkdownSnapshot } from "@unidocs/tenant-portal-client";
import { useDocumentSession } from "../model/use-document.js";
import { ThreadPanel } from "../panel/thread-panel.js";
import { routeToHash } from "../router.js";
import { ViewHost } from "../view/view-host.js";
import "./document.css";

export function DocumentPage(props: { documentId: string; threadId?: string; pingIdx?: number }) {
  const session = useDocumentSession(props.documentId);

  if (session.failure !== null) return <main className="document"><p role="alert">{session.failure.message}</p></main>;
  if (session.loading || session.document === null) return <main className="document"><p className="muted">加载中……</p></main>;

  const currentContent = (session.currentVersion?.snapshot as unknown as MarkdownSnapshot | undefined)?.content ?? "";

  return (
    <main className="document">
      <header className="document-top">
        <h1>{session.document.name}</h1>
        <span className="readonly-badge">只读 · 内容由 Agent 编辑</span>
      </header>

      <div className="document-body">
        {session.currentVersion === null
          ? <p className="muted">这件作品还在初始化，暂时没有可读的版本。</p>
          : <ViewHost label="当前版本" version={session.currentVersion} markers={[]} className="pane pane-current" />}

        <ThreadPanel
          threads={session.summary?.threads ?? []}
          currentVersionIdx={session.document.currentVersionIdx}
          selectedThreadId={props.threadId}
          onSelect={(threadId) => {
            window.location.hash = routeToHash({ kind: "document", documentId: props.documentId, threadId });
          }}
        />
      </div>
    </main>
  );
}
