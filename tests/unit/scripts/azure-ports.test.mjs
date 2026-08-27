import { describe, expect, test } from "vitest";
import {
  allAzurePorts,
  azurePortLayout,
  describeAzurePorts,
} from "../../../stacks/unidocs-azure/local/ports.mjs";

// 这个模块刻意零依赖,所以测试里直接给字面量,不 import doc-types.mjs ——
// 那会把 node:fs 拖进一个专门用来证明"不需要 node:fs"的测试里。
const PORT_BASES = { markdown: 41800, docx: 41810 };

describe("azurePortLayout", () => {
  test("defaults to markdown with two replicas", () => {
    expect(azurePortLayout({ portBases: PORT_BASES })).toEqual({
      gateway: 41787,
      docTypes: { markdown: { proxy: 41800, replicas: [41801, 41802] } },
    });
  });

  test("replica count drives the replica port list", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 3 });
    expect(layout.docTypes.markdown.replicas).toEqual([41801, 41802, 41803]);
  });

  test("each doc type gets its own non-overlapping band", () => {
    const layout = azurePortLayout({ docTypes: ["markdown", "docx"], portBases: PORT_BASES, replicas: 2 });
    expect(layout.docTypes.docx).toEqual({ proxy: 41810, replicas: [41811, 41812] });
    const ports = allAzurePorts(layout);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
  });

  // 副本数不能超出该 doc type 的端口段，否则会悄悄踩进下一个 doc type 的段。
  test("a replica count that overflows the band throws", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 20 }))
      .toThrow(/replicas/);
  });

  test("an unknown doc type throws, naming it and what is known", () => {
    expect(() => azurePortLayout({ docTypes: ["psd"], portBases: PORT_BASES }))
      .toThrow(/psd.*markdown, docx/s);
  });

  // portBases 是必填的:忘了传会让每个 doc type 都"未知",报错必须指向
  // 真正的原因,而不是让调用方以为 doc type 拼错了。
  test("omitting portBases throws about portBases, not about the doc type", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"] })).toThrow(/portBases/);
  });

  test("describeAzurePorts explains every port in the layout", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], portBases: PORT_BASES, replicas: 2 });
    const described = describeAzurePorts(layout);
    for (const port of allAzurePorts(layout)) {
      expect(described[port]).toBeTypeOf("string");
      expect(described[port].length).toBeGreaterThan(0);
    }
  });
});
