import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EtagSchema } from "@unidocs/protocol-admin-portal";
import { canonicalJson, contractHash, resourceEtag, schemaHash } from "../src/index.js";

describe("canonical resource identity", () => {
  test("matches the RFC 8785 serialization sample", () => {
    expect(canonicalJson({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    })).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u20ac$\\u000f\\nA\'B\\\"\\\\\\\"/"}');
  });

  test("sorts property names by UTF-16 code units without normalizing Unicode", () => {
    expect(canonicalJson({ "\ufffd": 7, "\u20ac": 4, "\r": 1, "\ufb33": 6, "1": 2, "\ud83d\ude00": 5, "\u0080": 3 }))
      .toBe('{"\\r":1,"1":2,"\u0080":3,"\u20ac":4,"\ud83d\ude00":5,"\ufb33":6,"\ufffd":7}');
    expect(canonicalJson(["\u00e9", "e\u0301", -0])).toBe('["\u00e9","e\u0301",0]');
  });

  test.each([NaN, Infinity, -Infinity, undefined, 1n, "\ud800", "\udfff", { "\ud800": true }, { value: undefined }, [undefined], Array(1), new Date()])(
    "rejects non-I-JSON input %#", value => {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    },
  );

  test("rejects cycles but permits repeated references to a JSON object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow("cycles");
    const child = { value: 1 };
    expect(canonicalJson([child, child])).toBe('[{"value":1},{"value":1}]');
  });

  test("pins SHA-256 hex schema identity and quoted base64url ETag", async () => {
    expect(await schemaHash({})).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(await resourceEtag({})).toBe('"sha256-RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o"');
    const etag = await resourceEtag({ name: "Markdown", enabled: false });
    expect(EtagSchema.parse(etag)).toBe(etag);
    expect(await resourceEtag({ enabled: false, etag: "ignored", name: "Markdown" })).toBe(etag);
    expect(await resourceEtag({ enabled: true, name: "Markdown" })).not.toBe(etag);
  });

  test("hashes only the paired contract content, not assigned idx, hashes or timestamps", async () => {
    const contract = { documentType: "markdown", formatVersion: 1, snapshot: { schema: { type: "string" }, schemaHash: "ignored" }, location: { schema: { type: "null" } }, documentContractIdx: 7 };
    const expected = '{"documentType":"markdown","formatVersion":1,"location":{"schema":{"type":"null"}},"snapshot":{"schema":{"type":"string"}}}';
    expect(await contractHash(contract)).toBe(`sha256:${createHash("sha256").update(expected).digest("hex")}`);
    expect(await contractHash({ ...contract, documentType: "psd" })).not.toBe(await contractHash(contract));
    expect(await contractHash({ ...contract, location: { schema: { type: "string" } } })).not.toBe(await contractHash(contract));
    expect(await contractHash({ ...contract, formatVersion: 2 })).not.toBe(await contractHash(contract));
  });
});