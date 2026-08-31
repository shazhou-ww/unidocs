import { dispatch } from "../controller.js";
import type { Rect } from "../../doc-model.js";
import { describeTarget } from "../region.js";
import { layersIntersecting } from "../hit-test.js";
import { selectedLayers, setRegion, setSelection, useUiState } from "../store.js";
import { ToolStrip } from "./tool-strip.js";

export function ContextBar() {
  const s = useUiState();
  const sel = selectedLayers(s);
  const m = s.region?.bounds ?? null;
  // A marquee `pointerdown` with no movement leaves a zero-area rect behind.
  // `crop` writes `doc.canvas.width = right - left` with no validation, so
  // offering the button for one would let a single click plus a single press
  // commit a 0x0 canvas. Only a selection with real area can be cropped to.
  const cropable = !!m && m[2] > m[0] && m[3] > m[1];
  return (
    <div className="context-bar">
      <span className="mono ctx-path">{describeTarget(sel.map((l) => l.name), s.region)}</span>
      {/* A mixed selection silently drops its locked members from a drag
          (draggableIds, canvas-stage.tsx) — "已锁定" and "部分已锁定" have to
          read differently, or that drop happens with no explanation on
          screen at all. */}
      {sel.length > 0 && sel.some((l) => l.locked)
        ? <span className="mono ctx-size">{sel.every((l) => l.locked) ? "已锁定" : "部分已锁定"}</span>
        : null}
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
