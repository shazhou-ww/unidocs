import { dispatch } from "../controller.js";
import { selectedLayers, setState, useUiState } from "../store.js";
import { ToolStrip } from "./tool-strip.js";

export function ContextBar() {
  const s = useUiState();
  const sel = selectedLayers(s);
  const m = s.marquee;
  return (
    <div className="context-bar">
      <span className="mono ctx-path">
        {sel.length ? `ir.root.${sel.map((l) => l.name).join(" + ")}` : "未选中图层"}
      </span>
      {m ? <span className="mono ctx-size">{`选区 ${m[3] - m[1]} × ${m[2] - m[0]}`}</span> : null}
      {m ? (
        <>
          <button type="button" className="btn-link"
                  onClick={() => void dispatch({ kind: "crop", payload: { rect: m } })}>裁到选区</button>
          <button type="button" className="btn-link"
                  onClick={() => setState({ marquee: null })}>清除选区</button>
        </>
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
