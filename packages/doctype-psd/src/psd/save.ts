import { writePsd, type Psd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer, LayerTextStyle, Mask } from "../model/types.js";
import { isRef } from "../render/pixel-source.js";
import { render } from "../render/composite.js";
import { installCanvasShim } from "./canvas-shim.js";

function agAdjustType(k: string): string {
  switch (k) {
    case "blwh": return "black & white";
    case "hue2": return "hue/saturation";
    case "brit": return "brightness/contrast";
    case "levl": return "levels";
    case "curv": return "curves";
    default: return k;
  }
}

function mapMask(m: Mask): AgLayer["mask"] {
  const [top, left, bottom, right] = m.bounds;
  const out: Record<string, unknown> = { top, left, bottom, right, defaultColor: m.defaultColor };
  if (m.pixels.width > 0) {
    out.imageData = { width: m.pixels.width, height: m.pixels.height, data: m.pixels.data };
  }
  return out as AgLayer["mask"];
}

/** LayerTextStyle → ag-psd TextStyle。字段名两边不同的只有 font / size /
 *  color / strokeWidth,其余同名直传。 */
function agTextStyle(s: LayerTextStyle): Record<string, unknown> {
  const caps = s.caps === "small" ? 1 : s.caps === "all" ? 2 : s.caps === "none" ? 0 : undefined;
  return {
    ...(s.font ? { font: { name: s.font } } : {}),
    ...(s.size !== undefined ? { fontSize: s.size } : {}),
    ...(s.color ? { fillColor: s.color } : {}),
    ...(s.tracking !== undefined ? { tracking: s.tracking } : {}),
    ...(s.leading !== undefined ? { leading: s.leading } : {}),
    ...(caps !== undefined ? { fontCaps: caps } : {}),
    ...(s.fauxBold !== undefined ? { fauxBold: s.fauxBold } : {}),
    ...(s.fauxItalic !== undefined ? { fauxItalic: s.fauxItalic } : {}),
    ...(s.horizontalScale !== undefined ? { horizontalScale: s.horizontalScale } : {}),
    ...(s.verticalScale !== undefined ? { verticalScale: s.verticalScale } : {}),
    ...(s.autoKerning !== undefined ? { autoKerning: s.autoKerning } : {}),
    ...(s.kerning !== undefined ? { kerning: s.kerning } : {}),
    ...(s.baselineShift !== undefined ? { baselineShift: s.baselineShift } : {}),
    ...(s.underline !== undefined ? { underline: s.underline } : {}),
    ...(s.strikethrough !== undefined ? { strikethrough: s.strikethrough } : {}),
    ...(s.ligatures !== undefined ? { ligatures: s.ligatures } : {}),
    ...(s.strokeColor ? { strokeColor: s.strokeColor } : {}),
    ...(s.strokeWidth !== undefined ? { outlineWidth: s.strokeWidth } : {}),
  };
}

export function mapLayer(l: Layer): AgLayer {
  // Defensive: tolerate a layer with missing bounds so a previously-corrupted
  // document can still be serialized (and thus recovered) instead of throwing.
  const [top, left, bottom, right] = l.bounds ?? [0, 0, 0, 0];
  const out: AgLayer = {
    name: l.name,
    opacity: l.opacity,
    // Back to ag-psd's space-separated names ("color-dodge" → "color dodge").
    blendMode: l.blendMode.replace(/-/g, " ") as any,
    hidden: !l.visible,
    clipping: l.clipping,
    left, top, right, bottom,
  };
  if (l.fillOpacity !== undefined && l.fillOpacity !== 1) out.fillOpacity = l.fillOpacity;
  // Write back the metadata load.ts preserved, so import → export → import is
  // lossless for layer STRUCTURE. `degraded` is deliberately NOT written: it
  // describes what the importer lost, not what the document contains, and
  // load() re-derives it on the next import.
  if (l.text) {
    out.text = {
      text: l.text.content,
      ...(l.text.transform ? { transform: l.text.transform } : {}),
      ...(l.text.shapeType ? { shapeType: l.text.shapeType } : {}),
      ...(l.text.boxBounds ? { boxBounds: l.text.boxBounds } : {}),
      ...(l.text.pointBase ? { pointBase: l.text.pointBase } : {}),
      ...(l.text.orientation ? { orientation: l.text.orientation } : {}),
      ...(l.text.style ? { style: agTextStyle(l.text.style) } : {}),
      // 逐段样式必须跟着写回去。只写顶层 style 的话,一次 import → export
      // 就会把"第二行是红的"这种信息抹掉 —— 导入侧刚补上的东西在往返里丢光,
      // 比不导入更糟。
      ...(l.text.runs ? { styleRuns: l.text.runs.map(r => ({ length: r.length, style: agTextStyle(r.style) })) } : {}),
      ...(l.text.paragraphStyle ? { paragraphStyle: { ...l.text.paragraphStyle } } : {}),
      ...(l.text.paragraphRuns
        ? { paragraphStyleRuns: l.text.paragraphRuns.map(r => ({ length: r.length, style: { ...r.style } })) }
        : {}),
      // `uneditable` 不写:和 `degraded` 一样,它描述的是我们的能力,不是文档
      // 的内容,load() 下次导入会重新推导。warp / textPath / gridInfo 本身走
      // 的是 ag-psd 自己的字段,不经过这里。
    } as any;
  }
  if (l.vector?.fill) out.vectorFill = l.vector.fill as any;
  if (l.vector?.stroke) out.vectorStroke = l.vector.stroke as any;
  if (l.smartObject) {
    // ag-psd's writer requires width/height (or a warp) on placedLayer, or it
    // throws "You must provide width and height of the linked image in
    // placedLayer". We don't carry the linked image's own dimensions, but
    // both Pixels and PixelRef expose width/height, so the layer's own baked
    // raster dimensions stand in.
    out.placedLayer = {
      id: l.smartObject.placedId,
      type: "raster",
      ...(l.pixels ? { width: l.pixels.width, height: l.pixels.height } : {}),
      ...(l.smartObject.transform ? { transform: l.smartObject.transform } : {}),
      ...(l.smartObject.sourceName ? { placed: l.smartObject.sourceName } : {}),
    } as any;
  }
  if (l.mask) out.mask = mapMask(l.mask);
  if (l.type === "adjustment" && l.adjustType) {
    out.adjustment = { type: agAdjustType(l.adjustType), ...(l.params ?? {}) } as any;
  } else if (l.children) {
    out.children = l.children.map(mapLayer);
  } else if (l.pixels) {
    // A PixelRef must be resolved to resident pixels before it can be written
    // to PSD; in this phase (resident docs) a ref should never reach save.
    if (isRef(l.pixels)) {
      throw new Error("save: layer pixels not resolved (PixelRef) — resolve before export");
    }
    out.imageData = { width: l.pixels.width, height: l.pixels.height, data: l.pixels.data } as any;
  }
  return out;
}

export async function save(doc: PsdDoc): Promise<Uint8Array> {
  installCanvasShim();
  // A PSD carries the layer stack AND a flattened composite (the "image data
  // section"). Photoshop is about the only reader that composes the layers
  // itself; Finder/Preview, browsers, thumbnailers and most other editors draw
  // the composite. This used to be a zero-filled buffer, so an export with
  // perfectly intact layers opened as a blank white image everywhere else —
  // composite it for real.
  //
  // `doc` reaches here already resolved (doctype.ts runs `resolveDoc` first),
  // so the compositor's default context never needs a BlobStore; a lazy
  // PixelRef that slipped through would throw here just as `mapLayer` below
  // throws for it.
  const composite = await render(doc);
  const psd: Psd = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    children: doc.layers.map(mapLayer),
    imageData: composite as any,
  };
  const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
  return new Uint8Array(buffer);
}
