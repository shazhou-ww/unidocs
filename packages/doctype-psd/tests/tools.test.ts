import { describe, it, expect } from "vitest";
import { tools, instructions } from "../src/tools.js";
import { SETTABLE_PROPS } from "../src/ops/layer-ops.js";

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

describe("setProps schema", () => {
  // 工具表已改成 AgentTool[],按 name 取而不是按 record 键取。
  const setPropsProps = () => {
    const tool = tools.find(t => t.name === "setProps");
    expect(tool, "setProps 必须在工具表里").toBeDefined();
    return (tool!.inputSchema as any).properties.props.properties;
  };

  it("exposes every settable prop", () => {
    const props = setPropsProps();
    for (const k of SETTABLE_PROPS) expect(Object.keys(props)).toContain(k);
  });

  it("declares stroke.position as an enum of the three PSD positions", () => {
    expect(setPropsProps().stroke.properties.position.enum).toEqual(["inside", "outside", "center"]);
  });
});

describe("instructions", () => {
  it("teaches the coordinate + clipping + preview model", () => {
    expect(instructions).toMatch(/\[top, ?left, ?bottom, ?right\]/);
    expect(instructions.toLowerCase()).toContain("clipping");
    expect(instructions.toLowerCase()).toContain("getpreview");
  });
});
