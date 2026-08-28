import { useState } from "react";
import { rollback } from "../api.js";
import { getController } from "../controller.js";
import { getState, reportError, type HistoryEntry } from "../store.js";

/**
 * The design nests this inside an agent message. It also backs the history
 * drawer, because locally-made edits belong to no message.
 *
 * The "diff" is the op payload ITSELF — the `+` half of the design's diff.
 * /history carries no before-values, so the `−` half is deliberately absent
 * (see the phase-1 design doc, §5.3).
 */
export function OpsList({ entries, defaultOpen = false }: { entries: HistoryEntry[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  if (entries.length === 0) return null;

  const ops = entries.flatMap((e) => e.operations);
  // Rolling back "these N steps" means returning to the state just before the
  // FIRST of them — i.e. one version below it.
  const target = entries[0].version - 1;

  const undo = async (): Promise<void> => {
    const docId = getState().docId;
    if (!docId || busy) return;
    setBusy(true);
    try {
      await rollback(docId, target);
      await getController()?.reconcile();
    } catch (e) {
      reportError("回退失败", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops">
      <button type="button" className="ops-head" onClick={() => setOpen(!open)}>
        <span className="mono caret">{open ? "▾" : "▸"}</span>
        <span className="mono">{ops.length} operations</span>
        <span className="tag-ok mono">已应用</span>
        <span className="spacer" />
        <span className="ops-toggle">查看 diff</span>
      </button>
      {open
        ? ops.map((op, i) => (
            <pre key={i} className="ir mono">{JSON.stringify(op, null, 2)}</pre>
          ))
        : null}
      <div className="ops-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void undo()}>
          回退这 {entries.length} 步
        </button>
      </div>
    </div>
  );
}
