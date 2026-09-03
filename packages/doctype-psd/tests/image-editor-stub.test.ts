import { describe, expect, it } from "vitest";
import { runImageEditorContract } from "../src/testing/image-editor-contract.js";
import { createStubEditor } from "../src/testing/stub-editor.js";

runImageEditorContract("stub", async () => createStubEditor(), { live: false });

describe("stub editor 的失败注入", () => {
  it("按注入的原因返回，不抛", async () => {
    const e = createStubEditor({ fail: { ok: false, reason: "refused", detail: "内容审核未通过" } });
    const r = await e.edit(
      { source: { width: 2, height: 2, data: new Uint8ClampedArray(16) }, instruction: "x" },
      AbortSignal.timeout(1000),
    );
    expect(r).toEqual({ ok: false, reason: "refused", detail: "内容审核未通过" });
  });
});
