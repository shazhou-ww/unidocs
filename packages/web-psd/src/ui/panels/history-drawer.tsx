import { opsSinceSession, setState, useUiState } from "../store.js";
import { OpsList } from "./ops-list.js";

/**
 * Covers the chat column with the full delta log. The design nests ops inside
 * agent messages, but locally-made edits (dragging a layer, moving a slider)
 * belong to no message — this is where they show up.
 *
 * `store.history` is filled by the chat header when the drawer opens, and
 * again after every agent turn (see chat-panel.tsx).
 */
export function HistoryDrawer() {
  const s = useUiState();
  const entries = opsSinceSession(s);
  return (
    <div className="drawer">
      <div className="col-head">
        <strong>历史</strong>
        <span className="mono pane-meta">{`${entries.length} ops · 本次会话`}</span>
        <span className="spacer" />
        <button type="button" className="chip" aria-label="关闭历史"
                onClick={() => setState({ historyOpen: false })}>关闭</button>
      </div>
      <div className="drawer-body">
        {entries.length === 0
          ? <div className="tree-empty">本次会话还没有改动</div>
          : [...entries].reverse().map((e) => (
              <div key={e.version} className="drawer-row"
                   data-head={e.version === s.version || undefined}
                   aria-label={e.version === s.version ? "当前版本" : undefined}>
                <div className="drawer-row-head">
                  <span className="mono">{e.description}</span>
                  <span className="spacer" />
                  <span className="mono pane-meta">{e.timestamp.slice(11, 19)}</span>
                </div>
                <OpsList entries={[e]} />
              </div>
            ))}
      </div>
    </div>
  );
}
