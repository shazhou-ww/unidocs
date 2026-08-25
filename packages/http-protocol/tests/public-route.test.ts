import { describe, expect, test } from "vitest";
import { isPublicCasRoute } from "../src/public-route.js";

describe("isPublicCasRoute", () => {
  test("allows the five public shapes", () => {
    expect(isPublicCasRoute("GET", "/users/u1/cas/usage")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u1/cas/nodes/abc")).toBe(true);
    expect(isPublicCasRoute("GET", "/users/u1/cas/nodes/abc/content")).toBe(true);
    expect(isPublicCasRoute("GET", "/users/u1/cas/nodes/abc/metadata")).toBe(true);
    expect(isPublicCasRoute("POST", "/users/u1/cas/nodes/abc/lease")).toBe(true);
  });

  // /_internal/root-refs 永远不是公开路由 —— 这是网关允许列表的全部意义。
  test("never allows the internal root-refs route", () => {
    expect(isPublicCasRoute("POST", "/_internal/root-refs")).toBe(false);
    expect(isPublicCasRoute("POST", "/users/u1/cas/_internal/root-refs")).toBe(false);
  });

  test("rejects wrong methods and wrong shapes", () => {
    expect(isPublicCasRoute("POST", "/users/u1/cas/usage")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/cas/gc")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/docs/markdown/d1")).toBe(false);
    expect(isPublicCasRoute("GET", "/users/u1/cas")).toBe(false);
    expect(isPublicCasRoute("POST", "/users/u1/cas/gc")).toBe(false);
  });
});
