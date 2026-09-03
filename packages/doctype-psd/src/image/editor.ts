import type { Pixels } from "../model/types.js";

/** 单通道覆盖度，0..255，长度 = width*height。白 = 改过，黑 = 没动。 */
export interface Coverage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface EditorCapabilities {
  /** 这个实现要不要蒙版。unsupported = 给了也没用，别费劲算。 */
  readonly mask: "required" | "optional" | "unsupported";
  /** 能接受的最小 / 最大像素数（width*height）。适配器自己负责缩放到区间内。 */
  readonly minPixels: number;
  readonly maxPixels: number;
  /** 输出是否自带隐形水印。true 时全图都在"变"，差异蒙版不可信。 */
  readonly watermarked: boolean;
}

export interface EditRequest {
  /** RGBA，任意尺寸。适配器负责把它变成 provider 能吃的形状。 */
  readonly source: Pixels;
  /** 白 = 改，黑 = 别动。capabilities.mask === "unsupported" 时被忽略。 */
  readonly mask?: Coverage;
  readonly instruction: string;
  readonly seed?: number;
}

export type EditResult =
  | {
    readonly ok: true;
    /**
     * 后置条件：与 `source` **严格同尺寸**，alpha 是适配器对模型这一侧的
     * **尽力估计**。
     *
     * 指令式模型吃 RGB 吐 RGB，交不出 alpha，所以只能靠哨兵底色临时把它编进
     * 色彩通道再判回来（guards.ts 的 compositeOnSentinel / recoverAlpha）。
     * 这条路只吐 0 或 255，且在轮廓边缘会失手：模型重采样把哨兵色和内容糊在
     * 一起，糊出来的中间色落在容差之外就被判成不透明。实测一个四周留透明的
     * 圆角矩形，该透明的像素里 1.9% 变成不透明（全贴着轮廓），526 个抗锯齿
     * 软边像素全部被二值化。
     *
     * **所以这份 alpha 不是最终答案。** 图层的轮廓要不要保住，是调用方的
     * 政策：重绘照片内部的内容时，应当按源的 alpha 裁回去（源的 alpha 是精确
     * 已知的，包括软边）；而换字体、重塑抠图、加发光这类**本来就要改轮廓**的
     * 编辑，就得用这里这份。见 edit-pixels.ts 的 `reshape`。
     */
    readonly pixels: Pixels;
    /**
     * 前后差异反推的蒙版，与 `source` 同尺寸。
     * `null` = 不可信（水印模型、或改动面积大到无法区分），调用方降级整层替换。
     */
    readonly changed: Coverage | null;
    readonly provenance: { readonly model: string; readonly seed: number; readonly prompt: string };
  }
  | {
    readonly ok: false;
    /**
     * refused       —— provider 拒绝了（内容审核等）。改措辞可能有救。
     * needs_mask    —— 这个实现要蒙版，调用方没给。
     * timeout       —— 超时。
     * provider_error—— 其他一切，包括适配器自己的后置条件断言失败。
     */
    readonly reason: "refused" | "needs_mask" | "timeout" | "provider_error";
    readonly detail: string;
  };

export interface ImageEditor {
  /** 稳定标识，进 provenance.model 和日志。 */
  readonly id: string;
  readonly capabilities: EditorCapabilities;
  edit(req: EditRequest, signal: AbortSignal): Promise<EditResult>;
}
