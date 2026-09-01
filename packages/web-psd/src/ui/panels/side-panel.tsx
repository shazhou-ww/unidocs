import { countLayers } from "../../doc-model.js";
import { useUiState } from "../store.js";
import { LayerTree } from "./layer-tree.js";
import { PropsPane } from "./props-pane.js";

/**
 * Layers and properties are STACKED, not tabbed.
 *
 * They used to be two tabs over one body, which put them in the worst
 * possible relationship: selecting a layer is the action that changes the
 * properties, and the tab hid whichever half you weren't on — so the whole
 * point of clicking a row (seeing what that layer *is*) needed a second
 * click, and every property edit needed a third to get back to the tree.
 * Stacking them costs vertical space and buys the feedback loop.
 *
 * The split is `flex-basis` percentages rather than fixed heights so both
 * halves grow with the window; each scrolls independently (`.tree` and
 * `.props` already own `overflow-y: auto`), so a long tree never pushes the
 * properties off-screen.
 */
export function SidePanel() {
  const s = useUiState();
  const total = s.doc ? countLayers(s.doc.layers) : 0;
  return (
    // `inert` 而不是给每个控件挂 disabled:它一次盖住指针、键盘焦点和 a11y
    // 树,而逐个 disabled 既要改十几处,又漏掉树里那些不是 <button> 的可点行。
    // `.is-locked` 只管视觉,不承担任何拦截职责。
    <aside className={`col-panel${s.opening ? " is-locked" : ""}`} inert={!!s.opening}>
      <section className="pane pane-layers">
        <div className="col-head">
          <strong>图层</strong>
          <span className="spacer" />
          <span className="mono pane-meta">{`${total} 图层`}</span>
        </div>
        <LayerTree />
      </section>
      <section className="pane pane-props">
        <div className="col-head">
          <strong>属性</strong>
          <span className="spacer" />
          <span className="mono pane-meta">{`${s.selection.length} 已选`}</span>
        </div>
        <PropsPane />
      </section>
    </aside>
  );
}
