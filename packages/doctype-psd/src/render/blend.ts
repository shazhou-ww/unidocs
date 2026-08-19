export type BlendFn = (cb: number, cs: number) => number;

/** Separable blend functions (backdrop, source in 0..1). Unlisted modes fall back to normal. */
const BLEND: Record<string, BlendFn> = {
  normal: (_cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  overlay: (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
  "color-dodge": (cb, cs) => (cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))),
  "color-burn": (cb, cs) => (cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)),
};

export function blendFn(mode: string): BlendFn {
  return BLEND[mode] ?? BLEND.normal;
}

type RGBA = [number, number, number, number];

/**
 * W3C compositing+blending of `src` over `dst` (straight RGBA, 0..1).
 * `src` alpha must already include the layer opacity. Returns straight RGBA (0..1).
 */
export function compositeOver(dst: RGBA, src: RGBA, mode: string): RGBA {
  const B = blendFn(mode);
  const [rb, gb, bb, ab] = dst;
  const [rs, gs, bs, as] = src;
  const ao = as + ab * (1 - as);
  if (ao === 0) return [0, 0, 0, 0];
  const ch = (cs: number, cb: number): number => {
    const mixed = (1 - ab) * cs + ab * B(cb, cs);
    const co = as * mixed + (1 - as) * ab * cb;
    return co / ao;
  };
  return [ch(rs, rb), ch(gs, gb), ch(bs, bb), ao];
}
