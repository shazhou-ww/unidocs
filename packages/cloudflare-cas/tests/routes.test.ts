import { describe, it, expect } from "vitest";
import { isPublicCasRoute } from "../src/public-cas-route";

const hash = "a".repeat(64);

describe("isPublicCasRoute", () => {
  it("allows the public CAS methods", () => {
    expect(isPublicCasRoute("POST", `/users/u/cas/nodes/${hash}`)).toBe(true);
    expect(isPublicCasRoute("POST", `/users/u/cas/nodes/${hash}/lease`)).toBe(true);
    expect(isPublicCasRoute("GET", `/users/u/cas/nodes/${hash}/content`)).toBe(true);
    expect(isPublicCasRoute("GET", `/users/u/cas/nodes/${hash}/metadata`)).toBe(true);
    expect(isPublicCasRoute("GET", "/users/u/cas/usage")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u/cas/gc")).toBe(true);
  });

  it("rejects root-refs and unknown paths", () => {
    expect(isPublicCasRoute("POST", "/users/u/cas/root-refs")).toBe(false);
    expect(isPublicCasRoute("POST", "/_internal/root-refs")).toBe(false);
    expect(isPublicCasRoute("PUT", `/users/u/cas/nodes/${hash}/content`)).toBe(false);
    expect(isPublicCasRoute("GET", `/users/u/cas/nodes/${hash}`)).toBe(false);
  });
});
