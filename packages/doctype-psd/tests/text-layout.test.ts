import { describe, expect, it } from "vitest";
import { layoutText } from "../src/text/layout.js";
import { fakeFace } from "./text-fake-face.js";

describe("layoutText", () => {
  it("逐字形累加步进宽度", () => {
    // 每个字形宽 1000 font units，em=1000 → 字号即步进
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 10]);
  });
});
