import { describe, expect, it } from "vitest";
import { parseRoute, routeToHash } from "../src/router.js";

describe("parseRoute", () => {
  it("空 hash 是工作台", () => {
    expect(parseRoute("")).toEqual({ kind: "workbench" });
    expect(parseRoute("#/")).toEqual({ kind: "workbench" });
  });

  it("文档路径", () => {
    expect(parseRoute("#/d/doc-sample")).toEqual({ kind: "document", documentId: "doc-sample" });
  });

  it("带一处与具体某条评论", () => {
    expect(parseRoute("#/d/doc-sample/th-open")).toEqual({
      kind: "document", documentId: "doc-sample", threadId: "th-open",
    });
    expect(parseRoute("#/d/doc-sample/th-open/2")).toEqual({
      kind: "document", documentId: "doc-sample", threadId: "th-open", pingIdx: 2,
    });
  });

  it("对路径段解码", () => {
    expect(parseRoute("#/d/doc%20one")).toEqual({ kind: "document", documentId: "doc one" });
  });

  it("认不出的 hash 回工作台", () => {
    expect(parseRoute("#/nonsense/x")).toEqual({ kind: "workbench" });
  });

  it("routeToHash 与 parseRoute 互为逆运算", () => {
    const route = { kind: "document", documentId: "doc one", threadId: "th/1", pingIdx: 0 } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});
