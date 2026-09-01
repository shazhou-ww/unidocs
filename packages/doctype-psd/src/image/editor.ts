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
     * 后置条件：与 `source` **严格同尺寸**，alpha 已还原。适配器必须自己断言。
     *
     * "已还原"只到**二值**为止：透明区是 0，其余是 255。指令式模型吃 RGB
     * 吐 RGB，alpha 是靠哨兵底色临时编码进色彩通道再判回来的（guards.ts 的
     * compositeOnSentinel / recoverAlpha），这条路只能区分"是不是哨兵色"，
     * 区分不出深浅。源里的部分透明不被保留。
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
