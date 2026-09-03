import { useRef, useState } from "react";
import { selectLayer, setState, useUiState } from "../store.js";
import { exportDoc, openFile } from "../controller.js";
import { collectDegradations, countLayers } from "../../doc-model.js";
import { zoomActual, zoomFit, zoomStep } from "../zoom-controller.js";

export function TopBar() {
  const s = useUiState();
  const fileRef = useRef<HTMLInputElement>(null);
  // 菜单开合是纯粹的一次性 UI 状态,别处没有人要关它,所以留在组件里而不是
  // 进全局 store。`degradeOpen` 进 store 是因为图层树点一下也要把它收起来。
  const [exportOpen, setExportOpen] = useState(false);
  const degradations = s.doc ? collectDegradations(s.doc.layers) : [];

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
                        onClick={() => { selectLayer(d.layerId); setState({ degradeOpen: false }); }}>
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
      <button
        type="button" className="btn"
        disabled={!!s.opening}
        onClick={() => fileRef.current?.click()}
      >打开</button>
      <input
        ref={fileRef} type="file" accept=".psd,.png" hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          // 立刻清空,不等 openFile 回来:同一个文件连选两次,第二次不触发
          // change,看起来像点了没反应。openFile 是 async 的,放到它之后清
          // 就等于在整个加载期间都留着这个坑。
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />
      {/* A button, not a link: the export has to flush the pending-op queue
          to the server before reading the document back from it, and a plain
          <a href> navigates without running any of our code. */}
      <div className="export">
        <button
          type="button" className="btn btn-primary"
          // `opening` 期间 docId 指向的可能正是那个正在被替换掉的旧文档。
          disabled={!s.docId || s.exporting || !!s.opening}
          onClick={() => setExportOpen(!exportOpen)}
        >
          {s.exporting ? "导出中…" : "导出"}
        </button>
        {exportOpen ? (
          <div className="export-pop">
            {(["psd", "png"] as const).map((format) => (
              <button
                key={format} type="button" className="export-row"
                // 触发按钮的守卫(`!s.docId || s.exporting || !!s.opening`)只挡住了
                // 「打开菜单」这一下——菜单一旦开着,后续点格式行完全没有守卫。
                // `opening` 期间 `docId` 可能仍指向即将被替换的旧文档:菜单开着
                // 时点「打开」选新文件会让这两行按钮对旧文档发起导出。
                disabled={s.exporting || !!s.opening}
                onClick={() => { setExportOpen(false); void exportDoc(format); }}
              >
                {`导出为 ${format.toUpperCase()}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
