import { describe, it, expect } from "vitest";
import { tools, instructions } from "../src/tools.js";
import { SETTABLE_PROPS } from "../src/ops/layer-ops.js";

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

describe("apply_set_props schema", () => {
  it("exposes every settable prop", () => {
    const props = (tools.set_props.inputSchema as any).properties.props.properties;
    for (const k of SETTABLE_PROPS) expect(Object.keys(props)).toContain(k);
  });

  it("declares stroke.position as an enum of the three PSD positions", () => {
    const props = (tools.set_props.inputSchema as any).properties.props.properties;
    expect(props.stroke.properties.position.enum).toEqual(["inside", "outside", "center"]);
  });
});

describe("instructions", () => {
  it("teaches the coordinate + clipping + preview model", () => {
    expect(instructions).toMatch(/\[top, ?left, ?bottom, ?right\]/);
    expect(instructions.toLowerCase()).toContain("clipping");
    expect(instructions.toLowerCase()).toContain("getpreview");
  });
});
