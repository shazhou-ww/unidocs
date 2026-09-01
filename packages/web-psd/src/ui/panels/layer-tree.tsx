import { useEffect, useRef } from "react";
import { flattenTree, layerKind, type LocalLayer } from "../../doc-model.js";
import { selectLayer, setState, toggleExpanded, useUiState } from "../store.js";
import { dispatch } from "../controller.js";

export function LayerTree() {
  const s = useUiState();
  if (!s.doc) return <div className="tree-empty">未打开文档</div>;
  const rows = flattenTree(s.doc.layers, s.expanded);
  return (
    <div className="tree">
      {rows.map(({ layer, depth, hasChildren }) => (
        <LayerRow key={layer.id} layer={layer} depth={depth} hasChildren={hasChildren} />
      ))}
    </div>
  );
}

function LayerRow({ layer, depth, hasChildren }: { layer: LocalLayer; depth: number; hasChildren: boolean }) {
  const s = useUiState();
  const selected = s.selection.includes(layer.id);
  const open = s.expanded.has(layer.id);
  const kind = layerKind(layer.type);
  const degraded = layer.degraded?.[0];
  const row = useRef<HTMLDivElement>(null);
  // A selection made on the canvas can land far outside the scrolled view.
  // `block: "nearest"` is a no-op when the row is already visible, so this
  // does not fight the user's own scrolling. Optional-called because jsdom
  // does not implement scrollIntoView.
  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return (
    <div
      className="tree-row"
      ref={row}
      data-selected={selected || undefined}
      data-hidden={!layer.visible || undefined}
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={(e) => selectLayer(layer.id, { additive: e.metaKey || e.ctrlKey })}
    >
      <button
        type="button"
        className="tree-eye mono"
        aria-label={`${layer.visible ? "隐藏" : "显示"} ${layer.name}`}
        onClick={(e) => {
          e.stopPropagation(); // toggling visibility must not move the selection
          void dispatch({ kind: "set_props", payload: { layerId: layer.id, props: { visible: !layer.visible } } });
        }}
      >
        {layer.visible ? "●" : "○"}
      </button>
      {hasChildren
        ? (
          <button
            type="button"
            className="tree-caret mono"
            aria-label={`${open ? "收起" : "展开"} ${layer.name}`}
            onClick={(e) => { e.stopPropagation(); setState({ expanded: toggleExpanded(s, layer.id) }); }}
          >
            {open ? "▾" : "▸"}
          </button>
        )
        : <span className="tree-caret" />}
      <span className="kind mono" data-kind={kind.token}>{kind.label}</span>
      <span className="tree-name">{layer.name}</span>
      {degraded ? <span className="tag-warn mono" title={degraded.reason}>降级</span> : null}
    </div>
  );
}
