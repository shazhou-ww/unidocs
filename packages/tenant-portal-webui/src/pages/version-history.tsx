import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, History, RotateCcw } from "lucide-react";
import type { SValue } from "@unidocs/protocol-platform";
import type { VersionRecord } from "@unidocs/protocol-tenant-portal";
import { useClient } from "../client-context.js";
import { errorText } from "../error-text.js";
import { routeToHash } from "../router.js";
import { ViewHost } from "../view/view-host.js";

const NO_MARKERS = [] as const;

export function VersionHistory(props: {
  documentId: string;
  currentVersionIdx: number;
  onClose(): void;
  onMoved(): void;
  onRefresh(): void;
}) {
  const client = useClient();
  const [versions, setVersions] = useState<readonly VersionRecord[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(props.currentVersionIdx);
  const [preview, setPreview] = useState<{ version: VersionRecord; snapshot: SValue } | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [moveFailure, setMoveFailure] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [confirmation, setConfirmation] = useState<{ target: number; observed: number } | null>(null);
  const [reason, setReason] = useState("");
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListFailure(null);
    void (async () => {
      const loaded: VersionRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listVersions(props.documentId, { cursor });
        if (cancelled) return;
        loaded.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      setVersions(loaded.sort((left, right) => right.versionIdx - left.versionIdx));
    })().catch((cause) => { if (!cancelled) setListFailure(errorText(cause)); });
    return () => { cancelled = true; };
  }, [client, props.documentId, props.currentVersionIdx, epoch]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewFailure(null);
    void Promise.all([
      client.getVersion(props.documentId, selectedIdx),
      client.getVersionSnapshot(props.documentId, selectedIdx),
    ]).then(([version, snapshot]) => {
      if (!cancelled) setPreview({ version, snapshot });
    }).catch((cause) => { if (!cancelled) setPreviewFailure(errorText(cause)); });
    return () => { cancelled = true; };
  }, [client, props.documentId, selectedIdx, epoch]);

  const selectVersion = (versionIdx: number) => {
    setSelectedIdx(versionIdx);
    setConfirmation(null);
    setMoveFailure(null);
    setReason("");
  };

  const move = async () => {
    if (confirmation === null || moving || reason.trim() === "") return;
    setMoving(true);
    setMoveFailure(null);
    try {
      await client.moveCurrentVersion(props.documentId, {
        observedCurrentVersionIdx: confirmation.observed,
        targetVersionIdx: confirmation.target,
        reason: reason.trim(),
      });
      props.onMoved();
    } catch (cause) {
      setMoveFailure(errorText(cause));
    } finally {
      setMoving(false);
    }
  };

  const ready = preview?.version.versionIdx === selectedIdx;
  return (
    <div className="doc-workspace history-workspace">
      <section className="content-area">
        <div className="pane-wrapper pane-base">
          <div className="history-toolbar">
            <div className="row"><History size={14} aria-hidden="true" /><select aria-label="查看版本" value={selectedIdx} disabled={moving || versions.length === 0} onChange={(event) => selectVersion(Number(event.target.value))}>
              {versions.length === 0 ? <option value={selectedIdx}>v{selectedIdx}</option> : versions.map((version) => <option key={version.versionIdx} value={version.versionIdx}>v{version.versionIdx}{version.versionIdx === props.currentVersionIdx ? " · 当前版本" : ""}</option>)}
            </select><span className="readonly-badge">只读</span></div>
            <button type="button" disabled={moving} onClick={props.onClose}><ArrowLeft size={14} aria-hidden="true" />返回讨论</button>
          </div>
          {previewFailure !== null ? (
            <div className="empty"><p role="alert">版本加载失败：{previewFailure}</p><button type="button" onClick={() => setEpoch((value) => value + 1)}>重试</button></div>
          ) : !ready ? <p className="empty" role="status">加载版本中…</p> : (
            <ViewHost key={`${props.documentId}:${selectedIdx}`} label={`历史版本 v${selectedIdx}`} version={preview.version} snapshot={preview.snapshot} markers={NO_MARKERS} commentable={false} className="pane prose" />
          )}
        </div>
      </section>
      <aside className="review-panel open history-panel" aria-label="版本历史">
        <header className="review-heading"><h2>版本历史</h2><span className="muted">当前 v{props.currentVersionIdx}</span></header>
        {listFailure !== null && <div className="review-body"><p role="alert">历史加载失败：{listFailure}</p><button type="button" onClick={() => setEpoch((value) => value + 1)}>重新加载历史</button></div>}
        {versions.length === 0 && listFailure === null && <p className="empty" role="status">加载历史中…</p>}
        <ol className="version-timeline">
          {versions.map((version) => (
            <li key={version.versionIdx} className={version.versionIdx === selectedIdx ? "selected" : ""}>
              <button type="button" className="version-choice" aria-label={`查看 v${version.versionIdx}`} aria-pressed={version.versionIdx === selectedIdx} disabled={moving} onClick={() => selectVersion(version.versionIdx)}>
                <strong>v{version.versionIdx}</strong>
                {version.versionIdx === props.currentVersionIdx && <span className="version-badge">当前版本</span>}
                <time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
              </button>
              <p className="version-parent">{version.parentVersionIdx === null ? "初始版本" : `基于 v${version.parentVersionIdx}`}</p>
              {version.addressedComments.length > 0 && <div className="version-provenance">
                <span>回应的评论</span>
                {version.addressedComments.map((source) => (
                  <a key={`${source.threadId}:${source.commentIdx}`} href={routeToHash({ kind: "document", documentId: props.documentId, threadId: source.threadId, commentIdx: source.commentIdx })} onClick={(event) => { if (moving) event.preventDefault(); else props.onClose(); }}>
                    评论 {source.commentIdx + 1} · 基于 v{source.baseVersionIdx}<ArrowRight size={12} aria-hidden="true" />
                  </a>
                ))}
              </div>}
            </li>
          ))}
        </ol>
        {selectedIdx !== props.currentVersionIdx && ready && <section className="version-restore">
          <p>把当前版本移到 v{selectedIdx}，此操作将写入文档审计。</p>
          {confirmation === null ? (
            <button type="button" onClick={() => setConfirmation({ target: selectedIdx, observed: props.currentVersionIdx })}><RotateCcw size={14} aria-hidden="true" />设为当前版本</button>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); void move(); }}>
              <label>变更原因<textarea autoFocus value={reason} disabled={moving} onChange={(event) => setReason(event.target.value)} required /></label>
              {moveFailure !== null && <div><p role="alert">切换失败：{moveFailure}</p><button type="button" disabled={moving} onClick={() => { props.onRefresh(); setConfirmation(null); setMoveFailure(null); }}>刷新当前版本</button></div>}
              <div className="row"><button type="submit" className="primary" disabled={moving || reason.trim() === ""}>{moving ? "切换中…" : "确认切换"}</button><button type="button" disabled={moving} onClick={() => setConfirmation(null)}>取消</button></div>
            </form>
          )}
        </section>}
      </aside>
    </div>
  );
}