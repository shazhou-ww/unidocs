import { useRef } from "react";
import { setState, useUiState } from "../store.js";
import { exportUrl, getController, openFile } from "../controller.js";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

export function TopBar() {
  const s = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);

  const stepZoom = (delta: number): void => {
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom + delta));
    if (zoom === s.zoom) return;
    setState({ zoom });
    getController()?.setZoom(zoom);
  };

  const href = exportUrl();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark mono">ir</span>
        <span className="brand-name">Aperture</span>
      </div>
      <span className="divider" />
      <span className="mono doc-name">{s.docName ?? "—"}</span>
      <span className="spacer" />
      <span className="mono status">{s.status}</span>
      <div className="zoom">
        <button type="button" aria-label="缩小" onClick={() => stepZoom(-ZOOM_STEP)}>−</button>
        <span className="mono zoom-label">{Math.round(s.zoom * 100)}%</span>
        <button type="button" aria-label="放大" onClick={() => stepZoom(ZOOM_STEP)}>+</button>
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
