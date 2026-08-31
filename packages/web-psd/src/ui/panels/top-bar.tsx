import { useRef } from "react";
import { selectLayer, setState, useUiState } from "../store.js";
import { exportUrl, openFile } from "../controller.js";
import { collectDegradations, countLayers } from "../../doc-model.js";
import { zoomActual, zoomFit, zoomStep } from "../zoom-controller.js";

export function TopBar() {
  const s = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);
  const degradations = s.doc ? collectDegradations(s.doc.layers) : [];

  const href = exportUrl();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark mono">ir</span>
        <span className="brand-name">Aperture</span>
      </div>
      <span className="divider" />
      <span className="mono doc-name">{s.docName ?? "—"}</span>
      {s.doc ? <span className="tag-ok mono">{`v${s.version} · ${countLayers(s.doc.layers)} 图层`}</span> : null}
      {degradations.length > 0 ? (
        <div className="degrade">
          <button type="button" className="tag-warn mono"
                  onClick={() => setState({ degradeOpen: !s.degradeOpen })}>
            {`${degradations.length} 项降级 ›`}
          </button>
          {s.degradeOpen ? (
            <div className="degrade-pop">
              {degradations.map((d, i) => (
                <button key={`${d.layerId}-${i}`} type="button" className="degrade-row"
                        onClick={() => { selectLayer(d.layerId); setState({ pane: "props", degradeOpen: false }); }}>
                  <strong>{d.layerName}</strong>
                  <span>{d.reason}</span>
                  {d.detail ? <em>{d.detail}</em> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="spacer" />
      <span className="mono status">{s.status}</span>
      <div className="zoom">
        <button type="button" aria-label="缩小" onClick={() => zoomStep(-1)}>−</button>
        {/* The readout is the control: click to toggle between fitting the
            document and 1:1, the two zooms worth reaching in one gesture. */}
        <button
          type="button"
          className="mono zoom-label"
          title={s.zoom === 1 ? "适应窗口" : "实际大小 (100%)"}
          aria-label={s.zoom === 1 ? "适应窗口" : "实际大小"}
          onClick={() => (s.zoom === 1 ? zoomFit() : zoomActual())}
        >
          {formatZoom(s.zoom)}
        </button>
        <button type="button" aria-label="放大" onClick={() => zoomStep(1)}>+</button>
      </div>
      <button type="button" className="btn" onClick={() => fileRef.current?.click()}>打开</button>
      <input
        ref={fileRef} type="file" accept=".psd" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); }}
      />
      {href
        ? <a className="btn btn-primary" href={href} download="export.psd">导出</a>
        : <span className="btn btn-primary is-disabled">导出</span>}
    </header>
  );
}

/** Zoom as a percentage. Sub-10% zooms (a very large document fitted to the
 *  window) need a decimal to not all read "0%" or "5%"; everything else is a
 *  whole number, which is what the ladder produces anyway. */
export function formatZoom(zoom: number): string {
  const pct = zoom * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}
