import { describe, it, expect } from "vitest";
import { tools, instructions } from "../src/tools.js";

describe("tools", () => {
  it("every tool has a clean name + op metadata", () => {
    for (const t of Object.values(tools)) {
      expect(t.name).not.toMatch(/^(query_|apply_)/);
      expect(["query", "apply"]).toContain(t.op!.mode);
      expect(typeof t.op!.kind).toBe("string");
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
