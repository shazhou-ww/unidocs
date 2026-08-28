import { selectedLayers, useUiState } from "../store.js";
import { dispatch } from "../controller.js";
import type { LocalLayer } from "../../doc-model.js";

const BLEND_MODES = [
  "normal", "dissolve", "darken", "multiply", "color-burn", "linear-burn",
  "lighten", "screen", "color-dodge", "linear-dodge", "overlay",
  "soft-light", "hard-light", "vivid-light", "linear-light",
  "difference", "exclusion", "subtract", "divide",
  "hue", "saturation", "color", "luminosity", "pass-through",
];

interface Stroke { color: { r: number; g: number; b: number }; opacity: number; size: number; position: string; blendMode: string }
interface Overlay { r: number; g: number; b: number; opacity: number }

const hex = (c: { r: number; g: number; b: number }): string =>
  "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
const unhex = (s: string): { r: number; g: number; b: number } => ({
  r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16),
});

/** Everything the IR snippet must not show: raw pixel buffers and the subtree. */
const IR_OMIT = new Set(["pixels", "mask", "children"]);

export function PropsPane() {
  const s = useUiState();
  const sel = selectedLayers(s);
  if (sel.length === 0) return <div className="tree-empty">未选中图层</div>;
  // Multi-select edits every selected layer with the same value; the readouts
  // below describe the first one, matching the design's single-target panel.
  const l = sel[0];
  const ids = sel.map((x) => x.id);

  const write = (props: Record<string, unknown>): void => {
    for (const layerId of ids) void dispatch({ kind: "set_props", payload: { layerId, props } });
  };

  const [top, left, bottom, right] = l.bounds ?? [0, 0, 0, 0];
  const stroke = l.stroke as Stroke | undefined;
  const overlay = l.colorOverlay as Overlay | undefined;
  const shadow = l.dropShadow as { size: number; distance: number; angle: number } | undefined;

  const ir = JSON.stringify(
    Object.fromEntries(Object.entries(l).filter(([k]) => !IR_OMIT.has(k))),
    null, 2,
  );

  return (
    <div className="props">
      <div className="props-ctx mono">{`ir.root.${l.name}`}</div>

      <section className="prop-group">
        <h3>变换</h3>
        <Row k="x / y" v={`${left}, ${top}`} />
        <Row k="w / h" v={`${right - left} × ${bottom - top}`} />
      </section>

      <section className="prop-group">
        <h3>外观</h3>
        <label className="prop-row">
          <span>不透明度</span>
          <input aria-label="不透明度" type="range" min={0} max={100}
                 value={Math.round(l.opacity * 100)}
                 onChange={(e) => write({ opacity: Number(e.target.value) / 100 })} />
        </label>
        <label className="prop-row">
          <span>填充不透明度</span>
          <input aria-label="填充不透明度" type="range" min={0} max={100}
                 value={Math.round((l.fillOpacity ?? 1) * 100)}
                 onChange={(e) => write({ fillOpacity: Number(e.target.value) / 100 })} />
        </label>
        <label className="prop-row">
          <span>混合模式</span>
          <select aria-label="混合模式" value={l.blendMode}
                  onChange={(e) => write({ blendMode: e.target.value })}>
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="prop-row">
          <span>锁定</span>
          <input aria-label="锁定" type="checkbox" checked={!!l.locked}
                 onChange={(e) => write({ locked: e.target.checked })} />
        </label>
        <label className="prop-row">
          <span>剪贴到下层</span>
          <input aria-label="剪贴到下层" type="checkbox" checked={!!l.clipping}
                 onChange={(e) => write({ clipping: e.target.checked })} />
        </label>
      </section>

      {(stroke || overlay || shadow) ? (
        <section className="prop-group">
          <h3>效果</h3>
          {stroke ? (
            <>
              <label className="prop-row">
                <span>描边宽度</span>
                <input aria-label="描边宽度" type="number" min={0} value={stroke.size}
                       onChange={(e) => write({ stroke: { ...stroke, size: Number(e.target.value) } })} />
              </label>
              <label className="prop-row">
                <span>描边颜色</span>
                <input aria-label="描边颜色" type="color" value={hex(stroke.color)}
                       onChange={(e) => write({ stroke: { ...stroke, color: unhex(e.target.value) } })} />
              </label>
              <Row k="描边位置" v={stroke.position} />
              <button type="button" className="btn-link" aria-label="移除描边"
                      onClick={() => write({ stroke: null })}>移除描边</button>
            </>
          ) : null}
          {overlay ? (
            <>
              <label className="prop-row">
                <span>颜色叠加</span>
                <input aria-label="颜色叠加" type="color" value={hex(overlay)}
                       onChange={(e) => write({ colorOverlay: { ...unhex(e.target.value), opacity: overlay.opacity } })} />
              </label>
              <button type="button" className="btn-link" aria-label="移除颜色叠加"
                      onClick={() => write({ colorOverlay: null })}>移除颜色叠加</button>
            </>
          ) : null}
          {shadow ? (
            <>
              <Row k="投影" v={`${shadow.distance}px @ ${shadow.angle}° · 模糊 ${shadow.size}`} />
              <button type="button" className="btn-link" aria-label="移除投影"
                      onClick={() => write({ dropShadow: null })}>移除投影</button>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="prop-group">
        <h3>IR 片段</h3>
        <pre className="ir mono" aria-label="IR 片段">{ir}</pre>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="prop-row"><span>{k}</span><span className="mono">{v}</span></div>;
}
