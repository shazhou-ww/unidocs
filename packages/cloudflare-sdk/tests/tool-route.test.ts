import { describe, it, expect } from "vitest";
import { resolveToolRoute } from "../src/tool-route.js";

describe("resolveToolRoute", () => {
  it("uses op metadata when present", () => {
    expect(resolveToolRoute("setLayerProps", {
      name: "setLayerProps", description: "", inputSchema: {}, op: { mode: "apply", kind: "set_props" },
    })).toEqual({ mode: "apply", kind: "set_props" });
  });

  it("falls back to query_/apply_ prefix when op is absent", () => {
    expect(resolveToolRoute("query_getLayers")).toEqual({ mode: "query", kind: "getLayers" });
    expect(resolveToolRoute("apply_set_props")).toEqual({ mode: "apply", kind: "set_props" });
  });

  it("returns null for an unrecognized name", () => {
    expect(resolveToolRoute("frobnicate")).toBeNull();
  });
});
