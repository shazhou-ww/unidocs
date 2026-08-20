import { describe, it, expect } from "vitest";
import { tools, instructions } from "../src/tools.js";

describe("tools", () => {
  it("every tool has a prefixed name and no op metadata", () => {
    for (const t of Object.values(tools)) {
      expect(t.name).toMatch(/^(query_|apply_)/);
      expect((t as any).op).toBeUndefined();
    }
  });

  it("blendMode is enumerated in setLayerProps", () => {
    const setProps = tools.set_props.inputSchema as any;
    expect(setProps.properties.props.properties.blendMode.enum).toContain("multiply");
  });
});

describe("instructions", () => {
  it("teaches the coordinate + clipping + preview model", () => {
    expect(instructions).toMatch(/\[top, ?left, ?bottom, ?right\]/);
    expect(instructions.toLowerCase()).toContain("clipping");
    expect(instructions.toLowerCase()).toContain("getpreview");
  });
});
