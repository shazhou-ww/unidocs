import { describe, expect, test } from "vitest";
import {
  allAzurePorts,
  azurePortLayout,
  describeAzurePorts,
} from "../../../azure/local/ports.mjs";

describe("azurePortLayout", () => {
  test("defaults to markdown with two replicas", () => {
    expect(azurePortLayout({})).toEqual({
      gateway: 41787,
      docTypes: { markdown: { proxy: 41800, replicas: [41801, 41802] } },
    });
  });

  test("replica count drives the replica port list", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], replicas: 3 });
    expect(layout.docTypes.markdown.replicas).toEqual([41801, 41802, 41803]);
  });

  test("each doc type gets its own non-overlapping band", () => {
    const layout = azurePortLayout({ docTypes: ["markdown", "docx"], replicas: 2 });
    expect(layout.docTypes.docx).toEqual({ proxy: 41810, replicas: [41811, 41812] });
    const ports = allAzurePorts(layout);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toEqual([...ports].sort((a, b) => a - b));
  });

  // 副本数不能超出该 doc type 的端口段，否则会悄悄踩进下一个 doc type 的段。
  test("a replica count that overflows the band throws", () => {
    expect(() => azurePortLayout({ docTypes: ["markdown"], replicas: 20 })).toThrow(
      /replicas/,
    );
  });

  test("an unknown doc type throws, naming it", () => {
    expect(() => azurePortLayout({ docTypes: ["psd"] })).toThrow(/psd/);
  });

  test("describeAzurePorts explains every port in the layout", () => {
    const layout = azurePortLayout({ docTypes: ["markdown"], replicas: 2 });
    const described = describeAzurePorts(layout);
    for (const port of allAzurePorts(layout)) {
      expect(described[port]).toBeTypeOf("string");
      expect(described[port].length).toBeGreaterThan(0);
    }
  });
});
