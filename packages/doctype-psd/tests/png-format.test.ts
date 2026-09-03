import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { decode, encode } from "fast-png";
import { readPsd } from "ag-psd";
import { createPsdDocumentType } from "../src/doctype.js";
import { pngToDoc, docToPng } from "../src/psd/png.js";
import type { PsdDoc } from "../src/model/types.js";
import { installCanvasShim } from "../src/psd/canvas-shim.js";
import { createMemorySBlobContext } from "./sblob-test-context.js";

/** 一张 3x2 的纯色 RGBA PNG。 */
function solidPng(r: number, g: number, b: number, a = 255): Uint8Array {
  const data = new Uint8Array(3 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return encode({ width: 3, height: 2, data, channels: 4, depth: 8 });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(body, 4);
  new DataView(out.buffer).setUint32(4 + body.length, crc32(body));
  return out;
}

/**
 * 手搓一张 0x0 的最小合法 PNG 字节流。
 *
 * `fast-png` 的 `encode()` 会主动拒绝零尺寸输入(`width must be a positive
 * integer`,见 `png_encoder.ts` 的 `checkInteger`),没法用它生成这种边界字节
 * 流去驱动 `pngToDoc` 的零尺寸分支;而 `decode()` 端的 IHDR 读取不做同样的
 * 校验,所以绕开 encoder、直接拼 IHDR/IDAT/IEND 三个 chunk 是可行的,已用
 * `decode()` 验证过能正常读出 `{ width: 0, height: 0 }`。
 */
function zeroExtentPng(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 0); // width
  dv.setUint32(4, 0); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
  const idat = deflateSync(new Uint8Array(0));
  return new Uint8Array([
    ...signature,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", idat),
    ...pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** 重新读一遍存好的 PSD,只要那张展平的合成图——image data section,
 *  Photoshop 之外的每个查看器画的都是它。抄自 save-composite.test.ts。 */
function compositeOf(bytes: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  installCanvasShim();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const psd = readPsd(buf, { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
  const img = psd.imageData;
  if (!img) throw new Error("saved PSD has no composite image data");
  return { width: img.width, height: img.height, data: img.data as Uint8ClampedArray };
}

describe("pngToDoc", () => {
  it("画布等于图片尺寸,恰好一个铺满画布的图层", () => {
    const doc = pngToDoc(solidPng(200, 100, 50));

    expect(doc.canvas.width).toBe(3);
    expect(doc.canvas.height).toBe(2);
    expect(doc.canvas.colorMode).toBe("RGB");
    expect(doc.layers).toHaveLength(1);
    // bounds 是 [top, left, bottom, right]
    expect(doc.layers[0]!.bounds).toEqual([0, 0, 2, 3]);
    expect(doc.layers[0]!.type).toBe("raster");
    expect(doc.layers[0]!.visible).toBe(true);
    expect(doc.layers[0]!.opacity).toBe(1);
  });

  // 图层 id 沿用 psd/load.ts:298 的 `l${i}_${name}` 形式。这不是美观问题:
  // 前端的选中、ops 的 layerId 都按这个约定走。
  it("图层 id 与 PSD 载入路径同一套命名", () => {
    expect(pngToDoc(solidPng(1, 2, 3)).layers[0]!.id).toBe("l0_背景");
  });

  it("零尺寸的 PNG 抛错", () => {
    // encode() 本身就拒绝 0 宽/高(见 zeroExtentPng() 上的注释),这里手搓
    // 字节流绕开它,直接驱动 pngToDoc 里 toRgba8 的零尺寸分支。
    expect(() => pngToDoc(zeroExtentPng())).toThrow(/zero/i);
  });
});

describe("docToPng", () => {
  it("PNG -> 文档 -> PNG 往返:像素不变", async () => {
    const original = solidPng(11, 22, 33, 44);
    const back = decode(await docToPng(pngToDoc(original)));

    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Array.from(back.data).slice(0, 4)).toEqual([11, 22, 33, 44]);
  });

  it("多图层被展平成一张合成图", async () => {
    // 下层不透明红,上层不透明蓝盖住左上角一格 -> 该格是蓝的,其余是红的。
    const doc: PsdDoc = {
      canvas: { width: 2, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [
        {
          id: "l0_bg", type: "raster", name: "bg", bounds: [0, 0, 1, 2],
          opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
          pixels: { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]) },
        },
        {
          id: "l1_dot", type: "raster", name: "dot", bounds: [0, 0, 1, 1],
          opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
          pixels: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) },
        },
      ],
    };

    const back = decode(await docToPng(doc));
    expect(Array.from(back.data)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });
});

describe("formats.png", () => {
  it("load 一张 PNG 得到可用文档,save 回来仍是 PNG", async () => {
    const ctx = createMemorySBlobContext().ctx;
    const dt = createPsdDocumentType(ctx);

    const state = await dt.formats.png!.load(solidPng(7, 8, 9));
    const bytes = await dt.formats.png!.save(state);
    const back = decode(bytes);

    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Array.from(back.data).slice(0, 4)).toEqual([7, 8, 9, 255]);
  });

  it("注册的 mediaType 与扩展名正是选格式要匹配的那两个", () => {
    const dt = createPsdDocumentType(createMemorySBlobContext().ctx);
    expect(dt.formats.png!.mediaTypes).toEqual(["image/png"]);
    expect(dt.formats.png!.extensions).toEqual([".png"]);
    // defaultFormat 不动:打开 PNG 之后文档仍然是 psd,默认导出仍是 PSD。
    expect(dt.defaultFormat).toBe("psd");
  });

  // 两条导出路径同源已经是既成事实:psd/save.ts:108 就是用同一个 render()
  // 生成 PSD 内嵌的展平合成图的。这条直接读 image data section 比对——
  // 走 psd.load 再重新合成只能证明往返保真,证明不了同源。
  it("PNG 导出与 PSD 内嵌的合成图逐像素一致", async () => {
    const ctx = createMemorySBlobContext().ctx;
    const dt = createPsdDocumentType(ctx);
    const state = await dt.formats.png!.load(solidPng(60, 120, 180));

    const asPng = decode(await dt.formats.png!.save(state));
    const embedded = compositeOf(await dt.formats.psd!.save(state));

    expect(embedded.width).toBe(asPng.width);
    expect(embedded.height).toBe(asPng.height);
    expect(Array.from(embedded.data)).toEqual(Array.from(asPng.data));
  });
});
