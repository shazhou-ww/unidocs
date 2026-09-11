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
      kind: "document", documentId: "doc-sample", threadId: "th-open", commentIdx: 2,
    });
  });

  it("对路径段解码", () => {
    expect(parseRoute("#/d/doc%20one")).toEqual({ kind: "document", documentId: "doc one" });
  });

  it("认不出的 hash 回工作台", () => {
    expect(parseRoute("#/nonsense/x")).toEqual({ kind: "workbench" });
  });

  it("畸形的 commentIdx 片段退化为只带 threadId,不被 Number() 强制转成合法整数", () => {
    const withoutCommentIdx = { kind: "document", documentId: "doc-sample", threadId: "th-open" };
    expect(parseRoute("#/d/doc-sample/th-open/")).toEqual(withoutCommentIdx);
    expect(parseRoute("#/d/doc-sample/th-open/%20")).toEqual(withoutCommentIdx);
    expect(parseRoute("#/d/doc-sample/th-open/0x2")).toEqual(withoutCommentIdx);
    expect(parseRoute("#/d/doc-sample/th-open/+2")).toEqual(withoutCommentIdx);
    expect(parseRoute("#/d/doc-sample/th-open/1e1")).toEqual(withoutCommentIdx);
  });

  it("routeToHash 与 parseRoute 互为逆运算", () => {
    const route = { kind: "document", documentId: "doc one", threadId: "th/1", commentIdx: 0 } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});
