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
 * Allocation-free core of `compositeOver`: W3C compositing+blending of a source
 * (rs,gs,bs,as) over a backdrop (rb,gb,bb,ab), all straight RGBA in 0..1, with
 * the blend function `B` already looked up by the caller (hoist `blendFn(mode)`
 * out of your loop). Writes the straight RGBA result into `out[outOff..outOff+3]`.
 *
 * This is the per-pixel hot path of the whole compositor, so it takes and
 * returns scalars: no tuples, no closures, no per-pixel table lookup. The three
 * channel expressions are deliberately inlined copies of one another — the
 * floating-point operations and their ORDER must stay exactly as they are (and
 * exactly as the original `ch` helper had them) or results stop being
 * bit-identical to previously rendered documents. Do not factor, reorder or
 * "simplify" them.
 */
export function compositeOverInto(
  out: Float64Array, outOff: number,
  rb: number, gb: number, bb: number, ab: number,
  rs: number, gs: number, bs: number, as: number,
  B: BlendFn,
): void {
  const ao = as + ab * (1 - as);
  if (ao === 0) {
    out[outOff] = 0; out[outOff + 1] = 0; out[outOff + 2] = 0; out[outOff + 3] = 0;
    return;
  }
  const mixedR = (1 - ab) * rs + ab * B(rb, rs);
  const coR = as * mixedR + (1 - as) * ab * rb;
  out[outOff] = coR / ao;
  const mixedG = (1 - ab) * gs + ab * B(gb, gs);
  const coG = as * mixedG + (1 - as) * ab * gb;
  out[outOff + 1] = coG / ao;
  const mixedB = (1 - ab) * bs + ab * B(bb, bs);
  const coB = as * mixedB + (1 - as) * ab * bb;
  out[outOff + 2] = coB / ao;
  out[outOff + 3] = ao;
}

/** Scratch for the tuple-returning `compositeOver` wrapper (single-threaded,
 *  and `compositeOverInto` cannot re-enter it). */
const scratch = new Float64Array(4);

/**
 * W3C compositing+blending of `src` over `dst` (straight RGBA, 0..1).
 * `src` alpha must already include the layer opacity. Returns straight RGBA (0..1).
 *
 * Convenience wrapper around `compositeOverInto` — byte-identical, but it
 * allocates tuples, so per-pixel loops should call the core directly.
 */
export function compositeOver(dst: RGBA, src: RGBA, mode: string): RGBA {
  const B = blendFn(mode);
  compositeOverInto(scratch, 0, dst[0], dst[1], dst[2], dst[3], src[0], src[1], src[2], src[3], B);
  return [scratch[0], scratch[1], scratch[2], scratch[3]];
}
