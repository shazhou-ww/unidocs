import { describe, it, expect } from "vitest";
import { toAnthropic } from "../src/anthropic.js";

describe("toAnthropic image tool results", () => {
  it("converts a $image getPreview result into an image block", () => {
    const session = [
      { role: "tool", tool_call_id: "t1", content: JSON.stringify({
        data: { $image: { base64: "AAAA", mediaType: "image/png" }, width: 10, height: 10, region: [0, 0, 10, 10] },
        version: 3,
      }) },
    ];
    const { messages } = toAnthropic(session);
    const result = (messages[0].content as any[])[0];
    expect(result.type).toBe("tool_result");
    expect(result.tool_use_id).toBe("t1");
    expect(Array.isArray(result.content)).toBe(true);
    const [img, text] = result.content;
    expect(img).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(text.type).toBe("text");
    expect(text.text).not.toContain("AAAA"); // base64 not re-embedded as text
    expect(text.text).toContain("preview");
  });

  it("leaves a plain-text tool result as a string", () => {
    const session = [
      { role: "tool", tool_call_id: "t2", content: JSON.stringify({ data: [{ id: "l0" }], version: 1 }) },
    ];
    const { messages } = toAnthropic(session);
    const result = (messages[0].content as any[])[0];
    expect(typeof result.content).toBe("string");
  });
});
