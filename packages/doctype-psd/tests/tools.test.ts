import { describe, it, expect } from "vitest";
import { tools, instructions } from "../src/tools.js";

describe("tools", () => {
  it("every tool has an un-prefixed name and a declared kind", () => {
    for (const t of tools) {
      expect(t.name).not.toMatch(/^(query_|apply_)/);
      expect(["query", "op"]).toContain(t.kind);
    }
  });

  it("blendMode is enumerated in setProps", () => {
    const setProps = tools.find(t => t.name === "setProps")!.inputSchema as any;
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
