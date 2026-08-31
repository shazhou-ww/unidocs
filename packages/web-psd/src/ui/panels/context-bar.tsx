import { useState } from "react";
import { dispatch, loadLayerAsRegion } from "../controller.js";
import type { Rect } from "../../doc-model.js";
import { describeTarget } from "../region.js";
import { layersIntersecting } from "../hit-test.js";
import { selectedLayers, setRegion, setSelection, useUiState } from "../store.js";
import { ToolStrip } from "./tool-strip.js";

export function ContextBar() {
  const s = useUiState();
  const sel = selectedLayers(s);
  const m = s.region?.bounds ?? null;
  // `layerAlphaRegion` samples the layer's alpha once per pixel of its box —
  // for a full-canvas layer in a real PSD that is tens of millions of
  // iterations. It is correctly off the UI thread, but the Worker's request
  // queue only discards `hitTest && hover`, so tiles and `applyOp` queue up
  // behind it and panning freezes for the duration. Nothing about the scan
  // itself changes here; what changes is that the user can see it is running
  // and cannot start a second one on top of the first.
  const [loadingRegion, setLoadingRegion] = useState(false);
  // A marquee `pointerdown` with no movement leaves a zero-area rect behind.
  // `crop` writes `doc.canvas.width = right - left` with no validation, so
  // offering the button for one would let a single click plus a single press
  // commit a 0x0 canvas. Only a selection with real area can be cropped to.
  const cropable = !!m && m[2] > m[0] && m[3] > m[1];
  return (
    <div className="context-bar">
      {/* Guarded on `s.doc`: `describeTarget([], null)` is「整个文档」, which
          is right for a document with nothing selected — but this bar renders
          unconditionally, so on the empty first screen it claimed the target
          was a whole document that is not open. */}
      <span className="mono ctx-path">
        {s.doc ? describeTarget(sel.map((l) => l.name), s.region) : "未选中图层"}
      </span>
      {/* A mixed selection silently drops its locked members from a drag
          (draggableIds, canvas-stage.tsx) — "已锁定" and "部分已锁定" have to
          read differently, or that drop happens with no explanation on
          screen at all. */}
      {sel.length > 0 && sel.some((l) => l.locked)
        ? <span className="mono ctx-size">{sel.every((l) => l.locked) ? "已锁定" : "部分已锁定"}</span>
        : null}
      {sel.length === 1 ? (
        <button type="button" className="btn-link" disabled={loadingRegion}
                onClick={() => {
                  setLoadingRegion(true);
                  void loadLayerAsRegion(sel[0].id).finally(() => setLoadingRegion(false));
                }}>载入为选区</button>
      ) : null}
      {loadingRegion ? <span className="mono ctx-busy">正在载入选区…</span> : null}
      {m ? <span className="mono ctx-size">{`选区 ${m[3] - m[1]} × ${m[2] - m[0]}`}</span> : null}
      {cropable ? (
        <button type="button" className="btn-link"
                onClick={() => void dispatch({ kind: "crop", payload: { rect: m as Rect } })}>裁到选区</button>
      ) : null}
      {m ? (
        <button type="button" className="btn-link"
                onClick={() => setSelection(layersIntersecting(s.doc?.layers ?? [], m))}>选中区域内的图层</button>
      ) : null}
      {m ? (
        <button type="button" className="btn-link"
                onClick={() => setRegion(null)}>清除选区</button>
      ) : null}
      {s.pickedColor ? (
        <span className="mono picked">
          <i style={{ background: s.pickedColor }} />{s.pickedColor}
        </span>
      ) : null}
      <span className="spacer" />
      <ToolStrip />
    </div>
  );
}
