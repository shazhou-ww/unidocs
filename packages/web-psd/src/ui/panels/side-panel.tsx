import { countLayers } from "../../doc-model.js";
import { setState, useUiState } from "../store.js";
import { LayerTree } from "./layer-tree.js";

export function SidePanel() {
  const s = useUiState();
  const total = s.doc ? countLayers(s.doc.layers) : 0;
  return (
    <aside className="col-panel">
      <div className="col-head pane-tabs">
        <button type="button" data-on={s.pane === "layers" || undefined}
                onClick={() => setState({ pane: "layers" })}>图层</button>
        <button type="button" data-on={s.pane === "props" || undefined}
                onClick={() => setState({ pane: "props" })}>属性</button>
        <span className="spacer" />
        <span className="mono pane-meta">
          {s.pane === "layers" ? `${total} 图层` : `${s.selection.length} 已选`}
        </span>
      </div>
      {s.pane === "layers" ? <LayerTree /> : null}
    </aside>
  );
}
