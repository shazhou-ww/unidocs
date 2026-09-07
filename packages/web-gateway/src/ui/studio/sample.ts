import type { Layer, PsdDoc } from "@unidocs/doctype-psd/engine";

const width = 960;
const height = 640;

function layer(id: string, name: string, paint: (context: CanvasRenderingContext2D) => void): Layer {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建画布");
  paint(context);
  return {
    id, name, type: "raster", bounds: [0, 0, height, width], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    pixels: { width, height, data: context.getImageData(0, 0, width, height).data }
  };
}

export function createStudioSample(): PsdDoc {
  return {
    canvas: { width, height, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [
      layer("background", "背景 · 雾绿", context => { context.fillStyle = "#e8eddf"; context.fillRect(0, 0, width, height); }),
      layer("composition", "构成 · 共创空间", context => {
        context.fillStyle = "#bacfca"; context.fillRect(540, 0, 420, 640);
        context.fillStyle = "#345749"; context.fillRect(590, 150, 190, 360);
        context.fillStyle = "#f5f4ea"; context.fillRect(665, 80, 230, 300);
        context.fillStyle = "#c67867"; context.fillRect(710, 340, 185, 220);
        context.strokeStyle = "#f5f4ea"; context.lineWidth = 2;
        for (let offset = 0; offset < 5; offset++) { context.beginPath(); context.moveTo(575 + offset * 20, 570); context.lineTo(640 + offset * 20, 490); context.stroke(); }
      }),
      layer("headline", "标题 · Ideas in good company", context => {
        context.fillStyle = "#293e30"; context.font = "bold 55px Georgia, serif";
        context.fillText("Ideas,", 46, 240); context.fillText("in good", 46, 310); context.fillText("company.", 46, 380);
      }),
      layer("caption", "副标题 · 与 AI 一起创作", context => {
        context.fillStyle = "#52664e"; context.font = '23px "Microsoft YaHei", sans-serif';
        context.fillText("给想法一个空间。", 48, 490); context.fillText("与 AI 一起，让创作继续。", 48, 530);
      }),
      layer("identity", "品牌与期号", context => {
        context.fillStyle = "#466046"; context.font = "20px Georgia, serif"; context.fillText("UniDocs / STUDIO", 48, 70);
        context.fillStyle = "#95a48c"; context.fillRect(48, 114, 425, 1);
        context.font = "13px monospace"; context.fillText("FIELD NOTES     /     001", 48, 594);
      }),
    ],
  };
}