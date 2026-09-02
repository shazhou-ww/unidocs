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
     * 后置条件：与 `source` **严格同尺寸**，且 alpha **逐像素等于 `source`
     * 的 alpha**。适配器必须自己断言。
     *
     * 也就是说：**图层的轮廓由源决定，模型改不了它。** 指令式模型吃 RGB 吐
     * RGB，本来就交不出 alpha；与其从它的输出里去猜一个我们已经精确知道的
     * 答案，不如直接抄过来。这样源里抗锯齿的软边（0..255 的连续值）原样保留。
     *
     * 曾经这里写的是"只到二值为止"，因为 alpha 是靠哨兵底色反推的（见
     * guards.ts 的 recoverAlpha）。那条路必然在轮廓边缘失手：模型重采样会把
     * 哨兵色和内容糊在一起，糊出来的中间色落在容差之外就被判成不透明。实测
     * 一个四周留透明的圆角矩形，该透明的像素里 1.9% 变成不透明、526 个软边
     * 像素全部被二值化 —— 落地就是沿轮廓一圈毛边，四周透不出去。
     *
     * 代价是模型画不到源的轮廓之外：给一个抠好的人像"加一顶帽子"，超出人像
     * 轮廓的部分会被裁掉。这是真实的限制，写在这里而不是藏着。
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
