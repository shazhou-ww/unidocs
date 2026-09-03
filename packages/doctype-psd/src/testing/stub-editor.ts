import type { Coverage, EditResult, EditorCapabilities, ImageEditor } from "../image/editor.js";

/**
 * 确定性的 ImageEditor 桩：把源像素左上角 1/4 区域涂成不透明红色，
 * 并如实报告改动区域。没有网络、没有随机数 —— 契约套件和 effect 单测
 * 靠它跑 `live: false` 的那一半。
 */
export function createStubEditor(opts: { fail?: Extract<EditResult, { ok: false }> } = {}): ImageEditor {
  const capabilities: EditorCapabilities = {
    mask: "optional",
    minPixels: 1,
    maxPixels: 64 * 1024 * 1024,
    watermarked: false,
  };
  return {
    id: "stub-editor",
    capabilities,
    async edit(req, signal) {
      if (signal.aborted) return { ok: false, reason: "timeout", detail: "aborted before start" };
      if (opts.fail) return opts.fail;
      const { width, height, data } = req.source;
      const out = new Uint8ClampedArray(data);
      const cov = new Uint8ClampedArray(width * height);
      const hw = Math.max(1, width >> 1);
      const hh = Math.max(1, height >> 1);
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < hw; x++) {
          const i = y * width + x;
          out.set([255, 0, 0, 255], i * 4);
          cov[i] = 255;
        }
      }
      const changed: Coverage = { width, height, data: cov };
      return {
        ok: true,
        pixels: { width, height, data: out },
        changed,
        provenance: { model: "stub-editor", seed: req.seed ?? 0, prompt: req.instruction },
      };
    },
  };
}
