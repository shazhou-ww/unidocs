import { describe, expect, it } from "vitest";
import { markdownAgent } from "../src/index.js";

const tool = (name: string) => {
  const t = markdownAgent.tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("Markdown 工具表", () => {
  it("工具名不带 query_ / apply_ 前缀", () => {
    for (const t of markdownAgent.tools) {
      expect(t.name).not.toMatch(/^(query|apply)_/);
    }
  });

  it("提示词里提到的每个工具名都真的存在", () => {
    const names = new Set(markdownAgent.tools.map(t => t.name));
    for (const n of ["getContent", "getHeadings", "getSection", "appendSection", "replaceSection", "deleteSection"]) {
      expect(names, `提示词让模型调 ${n}`).toContain(n);
    }
  });

  it("getContent 无参数时不带 payload —— {} 不能掩盖默认值", () => {
    const t = tool("getContent");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({})).toEqual({ kind: "getContent" });
  });

  it("getSection 有参数时透传成 payload", () => {
    const t = tool("getSection");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ heading: "Intro" })).toEqual({ kind: "getSection", payload: { heading: "Intro" } });
  });

  it("setContent 产出一个 op，参数原样透传", () => {
    const t = tool("setContent");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ content: "# New" })).toEqual([{ kind: "setContent", payload: { content: "# New" } }]);
  });

  it("appendSection 产出一个 op，参数原样透传", () => {
    const t = tool("appendSection");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ heading: "H", content: "body" }))
      .toEqual([{ kind: "appendSection", payload: { heading: "H", content: "body" } }]);
  });

  it("toQuery / toOps 是纯函数：同参调两次结果深相等（spec V7）", () => {
    for (const t of markdownAgent.tools) {
      const args = { heading: "Intro", content: "body" };
      const once = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      const twice = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      expect(twice).toEqual(once);
    }
  });
});

