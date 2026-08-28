import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import { psdAgent } from "../src/agent.js";

const tool = (name: string) => {
  const t = psdAgent.tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe("PSD 工具表", () => {
  it("工具名不带 query_ / apply_ 前缀", () => {
    for (const t of psdAgent.tools) {
      expect(t.name).not.toMatch(/^(query|apply)_/);
    }
  });

  it("提示词里提到的每个工具名都真的存在（修 spec 5.3.1 的缺陷）", () => {
    const names = new Set(psdAgent.tools.map(t => t.name));
    for (const n of ["getLayers", "getDoc", "getPreview", "transform", "editMask", "setAdjustment", "addLayer", "generativeFill"]) {
      expect(names, `提示词让模型调 ${n}`).toContain(n);
    }
  });

  it("getLayers 无参数时不带 payload —— {} 不能掩盖默认值", () => {
    const t = tool("getLayers");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({})).toEqual({ kind: "getLayers" });
  });

  it("getDoc 有参数时透传成 payload", () => {
    const t = tool("getDoc");
    if (t.kind !== "query") throw new Error("kind");
    expect(t.toQuery({ layerId: "L1" })).toEqual({ kind: "getDoc", payload: { layerId: "L1" } });
  });

  it("transform 产出一个 op，参数原样透传", () => {
    const t = tool("transform");
    if (t.kind !== "op") throw new Error("kind");
    expect(t.toOps({ layerId: "L1", op: { translate: [1, 2] } }))
      .toEqual([{ kind: "transform", payload: { layerId: "L1", op: { translate: [1, 2] } } }]);
  });

  it("toQuery / toOps 是纯函数：同参调两次结果深相等（spec V7）", () => {
    for (const t of psdAgent.tools) {
      const args = { layerId: "L1" };
      const once = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      const twice = t.kind === "query" ? t.toQuery(args) : t.toOps(args);
      expect(twice).toEqual(once);
    }
  });

  it("getPreview 返回 image content part，不再是 $image", () => {
    const t = tool("getPreview");
    if (t.kind !== "query" || !t.toResult) throw new Error("getPreview 必须有 toResult");
    const blob = createSBlob("a".repeat(64));
    const result = t.toResult(
      { image: blob, width: 8, height: 6, region: [0, 0, 6, 8] } as never,
      7,
    );
    expect(result.content).toEqual([{
      type: "image", blob, mediaType: "image/png",
      altText: "preview 8x6 region=[0,0,6,8] v7",
    }]);
    // 信封与 defaultQueryToolResult / docx 的 getImage 同形：{data, version}。
    expect(result.structuredContent).toEqual({
      data: { width: 8, height: 6, region: [0, 0, 6, 8] },
      version: 7,
    });
    expect(JSON.stringify(result)).not.toContain("$image");
  });

  it("getPreview 的结果缺 image 时抛错，不吞", () => {
    const t = tool("getPreview");
    if (t.kind !== "query" || !t.toResult) throw new Error("kind");
    expect(() => t.toResult!({ width: 8 } as never, 1)).toThrow(/SBlob/);
  });

  it("getPreview 的 region 也过窄化，形状不对就抛错", () => {
    const t = tool("getPreview");
    if (t.kind !== "query" || !t.toResult) throw new Error("kind");
    const blob = createSBlob("a".repeat(64));
    expect(() => t.toResult!(
      { image: blob, width: 8, height: 6, region: [0, 0, 6] } as never,
      1,
    )).toThrow("getPreview region must be an array of 4 finite numbers");
  });
});
