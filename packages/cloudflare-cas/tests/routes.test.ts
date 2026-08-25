import { describe, it, expect } from "vitest";
import { isCasRoute } from "../src/cas/routes";

const hash = "a".repeat(64);

describe("isCasRoute", () => {
  it("accepts tenant-scoped CAS service paths", () => {
    expect(isCasRoute(`/tenants/t/cas/nodes/${hash}`)).toBe(true);
    expect(isCasRoute(`/tenants/t/cas/nodes/${hash}/content`)).toBe(true);
    expect(isCasRoute("/tenants/t/cas/usage")).toBe(true);
  });

  it("rejects user and non-CAS paths", () => {
    expect(isCasRoute(`/users/u/cas/nodes/${hash}`)).toBe(false);
    expect(isCasRoute("/_internal/root-refs")).toBe(false);
    expect(isCasRoute("/tenants/t/docs/anything")).toBe(false);
  });
});
