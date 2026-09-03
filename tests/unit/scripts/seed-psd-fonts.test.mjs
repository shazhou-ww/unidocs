/**
 * `scripts/seed-psd-fonts.mjs` 的纯逻辑部分：配置解析、凭据解析、以及"字体文件
 * → 索引条目"这一步的三种拒绝理由。
 *
 * 网络那一半（写 CAS、登记、回读）不在这里 —— 它在
 * `tests/integration/cloudflare/psd-fonts-e2e.test.mjs` 里对着真 workerd 跑，
 * 用假 fetch 复刻一遍只会测出我自己对协议的想象。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countCjkCodePoints,
  countCodePoints,
  describeFont,
  loadKit,
  parseArgs,
  parseCredentials,
  parseSeedConfig,
} from "../../../scripts/seed-psd-fonts.mjs";
import * as kit from "../../../scripts/psd-fonts-kit.ts";
import { buildRectFont, buildSparseCoverageTestFont } from "../../../packages/doctype-psd/tests/text-test-font.ts";

const CONFIG_PATH = "/repo/psd-fonts.json";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function config(overrides) {
  return JSON.stringify({
    tenantId: "alice",
    fonts: [{ postScriptName: "NotoSans-Regular", file: "./fonts/NotoSans-Regular.ttf" }],
    ...overrides,
  });
}

describe("parseSeedConfig", () => {
  it("resolves font paths against the config file, not the process CWD", () => {
    const parsed = parseSeedConfig(config(), { configPath: CONFIG_PATH });
    expect(parsed.tenantId).toBe("alice");
    expect(parsed.fonts).toHaveLength(1);
    expect(parsed.fonts[0].file).toBe(join("/repo", "fonts", "NotoSans-Regular.ttf"));
    // family 没给时退回 postScriptName —— 索引里那一列没人读,但 DO 要求非空。
    expect(parsed.fonts[0].family).toBe("NotoSans-Regular");
  });

  it("keeps an absolute font path as given", () => {
    const absolute = join("/opt", "fonts", "X.ttf");
    const parsed = parseSeedConfig(
      config({ fonts: [{ postScriptName: "X", file: absolute }] }),
      { configPath: CONFIG_PATH },
    );
    expect(parsed.fonts[0].file).toBe(absolute);
  });

  it("names the file and the offending line for malformed JSON", () => {
    expect(() => parseSeedConfig("{ nope", { configPath: CONFIG_PATH }))
      .toThrow(/\/repo\/psd-fonts\.json: 不是合法的 JSON/);
  });

  it.each([
    ["顶层是数组", "[]", /顶层必须是一个 JSON 对象/],
    ["缺 tenantId", JSON.stringify({ fonts: [] }), /tenantId 必须是非空字符串/],
    ["fonts 是空数组", config({ fonts: [] }), /fonts 必须是非空数组/],
    ["条目缺 file", config({ fonts: [{ postScriptName: "X" }] }), /fonts\[0\]\.file 必须是非空字符串/],
    ["条目缺 postScriptName", config({ fonts: [{ file: "./x.ttf" }] }), /fonts\[0\]\.postScriptName 必须是非空字符串/],
  ])("rejects a bad config: %s", (_label, text, pattern) => {
    expect(() => parseSeedConfig(text, { configPath: CONFIG_PATH })).toThrow(pattern);
  });

  it("rejects a duplicated postScriptName instead of silently keeping the last one", () => {
    const text = config({
      fonts: [
        { postScriptName: "X", file: "./a.ttf" },
        { postScriptName: "X", file: "./b.ttf" },
      ],
    });
    expect(() => parseSeedConfig(text, { configPath: CONFIG_PATH }))
      .toThrow(/fonts\[1\]\.postScriptName 与前面的条目重复：X/);
  });

  // 这三个字段必须从字体文件解析。允许配置里出现它们等于允许一份"数字和字体
  // 对不上"的索引 —— 而那种错不会报错,只会让每个字都落在错的位置上。
  it.each(["unitsPerEm", "coverage", "hash"])("rejects a hand-written %s", (field) => {
    const text = config({
      fonts: [{ postScriptName: "X", file: "./x.ttf", [field]: field === "unitsPerEm" ? 1000 : "whatever" }],
    });
    expect(() => parseSeedConfig(text, { configPath: CONFIG_PATH }))
      .toThrow(new RegExp(`fonts\\[0\\]\\.${field} 不允许出现在配置里`));
  });

  // 示例配置是操作者第一眼看到的东西,也是文档里唯一一份"照着改就行"的样本。
  // 没人解析它的话,解析器加一条校验、或者示例里手滑写错一个字段名,都要等到
  // 部署者第一次跑脚本才炸。
  it("parses the example config that ships with the repository", async () => {
    const examplePath = join(ROOT, "scripts", "psd-fonts.example.json");
    const parsed = parseSeedConfig(await readFile(examplePath, "utf8"), { configPath: examplePath });
    expect(parsed.tenantId).toBe("alice");
    expect(parsed.fonts.map(font => font.postScriptName))
      .toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
    // 示例里写的是 `../fonts/…`,相对配置文件(scripts/)解释后落在仓库根的
    // `fonts/` —— 也就是 .gitignore 里那一条。写错了相对基准这里就对不上。
    expect(parsed.fonts.map(font => font.file)).toEqual([
      join(ROOT, "fonts", "NotoSans-Regular.ttf"),
      join(ROOT, "fonts", "NotoSansSC-Regular.otf"),
    ]);
  });
});

describe("parseCredentials", () => {
  const complete = {
    psdUrl: "http://127.0.0.1:8790/",
    casOrigin: "http://127.0.0.1:8794",
    doc: { issuer: "i", kid: "k", privateKeyPkcs8: "p" },
    stack: { stackId: "s", issuer: "si", audience: "sa", kid: "sk", privateKeyPkcs8: "sp" },
  };

  it("defaults the doc audience and the CAS ref domain", () => {
    const parsed = parseCredentials(JSON.stringify(complete), { credentialsPath: "/c.json" });
    expect(parsed.docAudience).toBe("unidocs-doc:psd");
    expect(parsed.stack.refDomain).toBe("doc");
    // 末尾斜杠留着会拼出 //tenants/... —— worker 的路由按段切,多一个空段就不匹配了。
    expect(parsed.psdUrl).toBe("http://127.0.0.1:8790");
  });

  it.each([
    ["psdUrl", "psdUrl"],
    ["casOrigin", "casOrigin"],
    ["doc.kid", "doc"],
    ["stack.privateKeyPkcs8", "stack"],
  ])("says which field is missing: %s", (name, group) => {
    const broken = structuredClone(complete);
    if (group === name) delete broken[name];
    else delete broken[group][name.split(".")[1]];
    expect(() => parseCredentials(JSON.stringify(broken), { credentialsPath: "/c.json" }))
      .toThrow(new RegExp(`/c\\.json: 缺少 ${name.replace(".", "\\.")}`));
  });
});

describe("coverage counting", () => {
  it("counts inclusive ranges", () => {
    expect(countCodePoints([[65, 65], [0x4e00, 0x4e02]])).toBe(4);
  });

  it("counts only the CJK slice, clipping ranges that straddle the block", () => {
    expect(countCjkCodePoints([[65, 65]])).toBe(0);
    expect(countCjkCodePoints([[0x4dff, 0x4e01]])).toBe(2);
    expect(countCjkCodePoints([[0x0020, 0x10ffff]])).toBe(0x9fff - 0x4e00 + 1);
  });
});

/**
 * 把一份字体字节里 `head` 表的 `unitsPerEm` 改掉,别的一概不动。
 *
 * 为什么要动字节而不是让构造器造一套:opentype.js 的写入器把 head 表的
 * `unitsPerEm` **硬编**成 1e3（`opentype.mjs` 的 `makeHeadTable` 里那条
 * `{ name: "unitsPerEm", type: "USHORT", value: 1e3 }` 根本不读 `font.unitsPerEm`）,
 * 所以 `buildRectFont` 造不出 1000 以外的 upm —— 而所有 fixture 的 upm 都是 1000,
 * "从文件解析 upm"写死成 1000 也照样全绿。
 *
 * 改了字节不会让解析失败:`parseHeadTable` 只校验 magicNumber,`checkSumAdjustment`
 * 是 `parseULong()` 读走就算,不做校验(同文件 `parseHeadTable`)。
 *
 * head 表内的偏移 +18 = version(4) + fontRevision(4) + checkSumAdjustment(4)
 * + magicNumber(4) + flags(2);表在文件里的位置从 sfnt 表目录里查。
 */
function withUnitsPerEm(source, unitsPerEm) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  for (let index = 0; index < numTables; index++) {
    // 表目录：12 字节文件头之后，每条记录 16 字节 = tag(4) + checkSum(4)
    // + offset(4) + length(4)。
    const record = 12 + index * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (tag === "head") {
      view.setUint16(view.getUint32(record + 8) + 18, unitsPerEm);
      return bytes;
    }
  }
  throw new Error("测试字体里没有 head 表");
}

describe("describeFont", () => {
  async function fontFile(bytes, name = "font.ttf") {
    const dir = await mkdtemp(join(tmpdir(), "unidocs-seed-fonts-"));
    const path = join(dir, name);
    await writeFile(path, bytes);
    return path;
  }

  it("parses unitsPerEm and coverage out of the file", async () => {
    const file = await fontFile(buildSparseCoverageTestFont());
    const described = await describeFont(kit, {
      postScriptName: "UnidocsTestFontRegular",
      family: "UnidocsTestFont",
      file,
    });
    expect(described.unitsPerEm).toBe(1000);
    // 'A' (0x41) 与 '中' (0x4E2D) 隔得很远,必须是两个区间而不是一个。
    expect(described.coverage).toEqual([[0x41, 0x41], [0x4e2d, 0x4e2d]]);
    expect(countCjkCodePoints(described.coverage)).toBe(1);
    expect(described.contentType).toBe("font/ttf");
  });

  // upm 决定每个字号下所有度量的缩放系数。报错的 upm 不会让任何东西失败,只会让
  // 每个字都落在错的位置上 —— 而 1000 是最常见的取值,恰恰最容易被"写死"蒙混过去。
  it("reads unitsPerEm out of the head table instead of assuming 1000", async () => {
    const file = await fontFile(withUnitsPerEm(buildSparseCoverageTestFont(), 2048));
    const described = await describeFont(kit, {
      postScriptName: "UnidocsTestFontRegular",
      family: "UnidocsTestFont",
      file,
    });
    expect(described.unitsPerEm).toBe(2048);
    // 只动了 upm 那两个字节,别的照旧 —— 免得这条测试在"字体整个坏掉"时也变绿。
    expect(described.coverage).toEqual([[0x41, 0x41], [0x4e2d, 0x4e2d]]);
  });

  it("names the missing path and where to get the font", async () => {
    await expect(describeFont(kit, {
      postScriptName: "NotoSansSC-Regular",
      family: "Noto Sans SC",
      file: "/nowhere/NotoSansSC-Regular.otf",
    })).rejects.toThrow(/字体文件不存在：\/nowhere\/NotoSansSC-Regular\.otf.*OFL/s);
  });

  it("prints both names when the configured one disagrees with the file", async () => {
    const file = await fontFile(buildSparseCoverageTestFont());
    await expect(describeFont(kit, {
      postScriptName: "NotoSans-Regular",
      family: "Noto Sans",
      file,
    })).rejects.toThrow(/配置里写的是 "NotoSans-Regular".*解析出来的是 "UnidocsTestFontRegular"/s);
  });

  it("names the file that failed to parse", async () => {
    const file = await fontFile(new Uint8Array([1, 2, 3, 4]), "broken.ttf");
    await expect(describeFont(kit, { postScriptName: "X", family: "X", file }))
      .rejects.toThrow(new RegExp(`字体文件 ${file.replaceAll("\\", "\\\\")} 解析失败`));
  });

  it("accepts a font whose coverage is a single code point", async () => {
    const file = await fontFile(buildRectFont([{ char: "A", width: 500, height: 700, advanceWidth: 600 }]));
    const described = await describeFont(kit, {
      postScriptName: "UnidocsTestFontRegular",
      family: "UnidocsTestFont",
      file,
    });
    expect(countCodePoints(described.coverage)).toBe(1);
  });
});

describe("parseArgs", () => {
  it("takes the config path positionally and defaults the credentials path", () => {
    expect(parseArgs(["psd-fonts.json"])).toMatchObject({
      configPath: "psd-fonts.json",
      credentialsPath: ".wrangler/unidocs/local-credentials.json",
    });
  });

  it("rejects an unknown flag rather than treating it as the config path", () => {
    expect(() => parseArgs(["--nope", "x"])).toThrow(/未知参数：--nope/);
  });

  it("requires a config path", () => {
    expect(() => parseArgs([])).toThrow(/缺少配置文件路径/);
  });
});

// CLI 走的是 esbuild 打出来的 bundle,测试走的是 TS 源码 —— 两条路。打包那条
// 没人测的话,别名表漏一项、或者某个包换了入口,都只会在部署者第一次跑脚本时
// 才炸,而那时他手里只有一句 ERR_MODULE_NOT_FOUND。
describe("loadKit", () => {
  it("bundles the TypeScript kit into something node can import", async () => {
    const bundled = await loadKit();
    for (const name of [
      "parseFontFace",
      "fontCoverage",
      "createTenantCasClient",
      "createCasBlobClient",
      "createPkcs8CapabilityIssuer",
      "casWritePermission",
      "sessionCreatePermission",
    ]) {
      expect(typeof bundled[name], name).toBe("function");
    }
    // 真的能解析字体,不只是"导出了一个同名函数"。
    const face = bundled.parseFontFace(buildSparseCoverageTestFont());
    expect(bundled.fontCoverage(face)).toEqual([[0x41, 0x41], [0x4e2d, 0x4e2d]]);
  }, 60_000);
});
