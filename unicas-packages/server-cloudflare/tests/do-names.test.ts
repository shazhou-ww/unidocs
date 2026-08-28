import { describe, expect, test } from "vitest";
import { canonicalComposite, decodeComposite, stackCanonicalNodeKey } from "../src/do-names.js";

describe("canonical DO name partitioning", () => {
  test("round-trips stack + tenant and stack + refDomain", () => {
    for (const [stackId, component] of [
      ["cas_stack_a", "tenant-1"],
      ["cas_stack_a", "doc"],
      ["stack/with:slashes", "tenant/with:colons"],
      ["cas_栈", "租户"],
    ]) {
      const name = canonicalComposite(stackId, component);
      expect(decodeComposite(name)).toEqual({ stackId, component });
    }
  });

  test("ambiguous delimiter concatenation is impossible", () => {
    // A `|` inside a component is encoded, so composites never collide.
    const a = canonicalComposite("s", "a|b");
    const b = canonicalComposite("s|a", "b");
    expect(a).not.toBe(b);
    expect(decodeComposite(a)).toEqual({ stackId: "s", component: "a|b" });
    expect(decodeComposite(b)).toEqual({ stackId: "s|a", component: "b" });
  });

  test("rejects empty parts and malformed composites", () => {
    expect(() => canonicalComposite("", "x")).toThrow();
    expect(() => canonicalComposite("x", "")).toThrow();
    expect(decodeComposite("no-separator")).toBeNull();
    expect(decodeComposite("|x")).toBeNull();
    expect(decodeComposite("x|")).toBeNull();
    expect(decodeComposite("%zz|x")).toBeNull();
  });

  test("R2 stack node keys are unambiguous", () => {
    expect(stackCanonicalNodeKey("cas_s", "tenant-1", "a".repeat(64)))
      .toBe(`stacks/cas_s/tenants/tenant-1/nodes-v2/${"a".repeat(64)}`);
  });
});
