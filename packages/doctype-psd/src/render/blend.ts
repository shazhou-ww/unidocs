export type BlendFn = (cb: number, cs: number) => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const colorDodge: BlendFn = (cb, cs) => (cs >= 1 ? 1 : Math.min(1, cb / (1 - cs)));
const colorBurn: BlendFn = (cb, cs) => (cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs));
// W3C soft-light D(cb) helper.
const softLightD = (cb: number) => (cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb));

/**
 * Separable blend functions (backdrop, source in 0..1). Keys are canonical
 * hyphenated names (see load.ts normalization). Unlisted / non-separable
 * modes (hue/saturation/color/luminosity, dissolve, pass-through) fall back
 * to normal.
 */
const BLEND: Record<string, BlendFn> = {
  normal: (_cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  overlay: (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
  "hard-light": (cb, cs) => (cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)),
  "color-dodge": colorDodge,
  "color-burn": colorBurn,
  "linear-dodge": (cb, cs) => clamp01(cb + cs),
  "linear-burn": (cb, cs) => clamp01(cb + cs - 1),
  "linear-light": (cb, cs) => clamp01(cb + 2 * cs - 1),
  "vivid-light": (cb, cs) => (cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * (cs - 0.5))),
  "pin-light": (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)),
  "soft-light": (cb, cs) =>
    cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (softLightD(cb) - cb),
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
  subtract: (cb, cs) => Math.max(0, cb - cs),
  divide: (cb, cs) => (cs <= 0 ? 1 : Math.min(1, cb / cs)),
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
