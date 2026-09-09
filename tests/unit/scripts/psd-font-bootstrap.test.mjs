/**
 * `scripts/psd-font-bootstrap.mjs` —— `pnpm dev` 启动时那一步"有就跳过，没有
 * 就灌"。
 *
 * 这里守的是**编排上的判断**：跳不跳、下哪几套、失败了会不会把 `pnpm dev`
 * 一起带走。真正的 CAS 写入与登记在
 * `tests/integration/cloudflare/psd-fonts-e2e.test.mjs` 里对着真 workerd 跑
 * （所以这里把 `seed` 换成探针不会留下窟窿）；而下载本身用真的
 * `downloadFont` 加一个假 fetch 测 —— 那一步唯一的价值就是校验，桩掉它等于
 * 什么都没测。
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_TENANT,
  PSD_FONT_PLAN,
  downloadFont,
  ensurePsdFonts,
  psdFontFallbacks,
} from "../../../scripts/psd-font-bootstrap.mjs";
import { parseSeedConfig } from "../../../scripts/seed-psd-fonts.mjs";
import * as kit from "../../../scripts/psd-fonts-kit.ts";
import { buildRectFont } from "../../../packages/doctype-psd/tests/text-test-font.ts";
// 只取 fallbacks.ts 而不是包的 index：那个入口还导出 provider，会把
// doctype-server-common 那条依赖链一起拖进来，而这里只要那两个名字。
import { BUILTIN_FALLBACKS } from "../../../packages/fonts-builtin/src/fallbacks.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PSD_URL = "http://127.0.0.1:8790";
const FONTS_URL = `${PSD_URL}/tenants/u1/fonts`;

/** 造出来的字体都叫这个名字（`familyName` + `styleName`，见 text-test-font.ts）。 */
const TEST_PS_NAME = "UnidocsTestFontRegular";
const TEST_FONT = buildRectFont([{ char: "A", width: 500, height: 700, advanceWidth: 600 }]);

let credentials;

beforeAll(async () => {
  // 读一次索引就要签一张真凭据（`createDocTokenFactory`），所以密钥不能是
  // 占位字符串 —— 假密钥会让整条路在签名那一步就抛，测出来的就不是编排了。
  const pair = await generateKeyPair("ES256", { extractable: true });
  await exportJWK(pair.publicKey);
  const privateKeyPkcs8 = await exportPKCS8(pair.privateKey);
  credentials = {
    psdUrl: PSD_URL,
    casOrigin: "http://127.0.0.1:8794",
    docAudience: "unidocs-doc:psd",
    doc: { issuer: "unidocs-gateway:test", kid: "test-1", privateKeyPkcs8 },
    stack: {
      stackId: "unidocs-cloudflare",
      issuer: "unidocs-stack:test",
      audience: "unidocs-cas-stack:test",
      kid: "stack-1",
      privateKeyPkcs8,
      refDomain: "doc",
    },
  };
});

/** 记下每一次 fetch 的方法与 URL —— "跳过时一次写都没发"靠它断言。 */
function recordingFetch(routes) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    calls.push({ method, url });
    const handler = routes[`${method} ${url}`] ?? routes[url];
    if (!handler) throw new Error(`unexpected ${method} ${url}`);
    return handler(init);
  };
  impl.calls = calls;
  return impl;
}

function indexResponse(fonts) {
  return () => new Response(JSON.stringify({ fonts }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 索引里的一条。`family` 故意和 `postScriptName` 不一样 —— 两个字段在真实索引里
 * 本来就可以不同（`family` 是随附元数据，排版链上没人读它），写成一样的话
 * "幂等判据拿错了字段"这种错在测试里根本显不出来。
 */
function indexEntry(postScriptName, family = `${postScriptName} 的家族名`) {
  return { postScriptName, family, hash: "0".repeat(64), unitsPerEm: 1000, coverage: [[0x41, 0x41]] };
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "unidocs-font-boot-"));
}

describe("这份计划里当兜底的那些名字", () => {
  it("是计划里那两套的 postScriptName，拉丁在前", () => {
    expect(psdFontFallbacks()).toBe("NotoSans-Regular,NotoSansSC-Regular");
  });

  // 内置字体随包发行之后，`pnpm dev` 不再传 PSD_FONT_FALLBACKS —— 默认值是
  // BUILTIN_FALLBACKS。本地灌的全量版之所以能顶掉内置子集，靠的**只有同名**
  // （createFontRegistry 按 postScriptName 覆盖）。名字一旦分叉，症状是静默的：
  // 索引里凭空多两条谁也选不中的条目，回退链照旧解析到内置子集，中文照样排得
  // 出来、只是少了两万多个码位。所以这条必须逐字盯着。
  it("与内置那一档逐字同名 —— 同名才覆盖", () => {
    expect(psdFontFallbacks().split(",")).toEqual([...BUILTIN_FALLBACKS]);
  });

  // 灌进索引 ≠ 进回退链。Josefin Sans Bold 是本地素材 PSD 点名的字体，灌上它
  // 那些层才是按原字形重排；但它只有 574 个纯拉丁码位，进了回退链就会在缺字体
  // 的中文层上被选中、然后一个字都画不出来。
  it("素材字体灌进计划但不进回退链", () => {
    const names = PSD_FONT_PLAN.map(font => font.postScriptName);
    expect(names).toContain("JosefinSans-Bold");
    expect(psdFontFallbacks().split(",")).not.toContain("JosefinSans-Bold");
  });

  // 缺省视为兜底 —— 不写 `fallback` 字段的计划（测试里的自制计划、以后新增的
  // 条目）行为不变，不会因为漏写一个字段就得到一条空回退链。
  it("没写 fallback 字段的条目照常进回退链", () => {
    expect(psdFontFallbacks([{ postScriptName: "A" }, { postScriptName: "B" }])).toBe("A,B");
  });

  // 家族名（NotoSans）和 postScriptName（NotoSans-Regular）写混了不会报错，
  // 只会让回退链静默失效。示例配置里那两个名字是拿真字体核对过的，所以这里
  // 拿它当基准 —— 两边只要有一边被改成家族名，这条就红。
  it("与示例配置里那两个名字逐字一致", async () => {
    const examplePath = join(ROOT, "scripts", "psd-fonts.example.json");
    const example = parseSeedConfig(await readFile(examplePath, "utf8"), { configPath: examplePath });
    expect(PSD_FONT_PLAN.map(font => font.postScriptName))
      .toEqual(example.fonts.map(font => font.postScriptName));
  });

  // .dev.vars.example 是操作者手工配这个变量时抄的地方。那一行现在只是**示例
  // 值**（不设这个变量才是常态，默认取 BUILTIN_FALLBACKS），但示例值抄错一样
  // 有害：写一个索引里没有的名字不报错，只让回退链静默失效。所以它必须仍然等于
  // 本地真正灌进去、且当兜底的那些名字。
  //
  // 那一行是注释掉的（`# PSD_FONT_FALLBACKS=…`），所以取值只能按第一个 `=` 切，
  // 不能整行解析成 KV。
  it("与 .dev.vars.example 里那个示例值一致", async () => {
    const text = await readFile(join(ROOT, "packages", "cloudflare-psd", ".dev.vars.example"), "utf8");
    const line = text.split("\n").find(l => l.includes("PSD_FONT_FALLBACKS="));
    expect(line).toBeDefined();
    expect(line.slice(line.indexOf("=") + 1).trim()).toBe(psdFontFallbacks());
  });

  // 新语义的另一半：**不设**才是默认（取内置那两套），**显式空串**是逃生口。
  // wrangler.toml 里留着一行 `PSD_FONT_FALLBACKS = ""` 就等于替生产选了逃生口，
  // 中文层整层画不出来 —— 那正是这次重构亲手挖过的地雷，所以钉住它别回来。
  it("wrangler.toml 不设这个变量", async () => {
    const text = await readFile(join(ROOT, "packages", "cloudflare-psd", "wrangler.toml"), "utf8");
    const assignment = text.split("\n")
      .filter(l => !l.trimStart().startsWith("#"))
      .find(l => /^\s*PSD_FONT_FALLBACKS\s*=/.test(l));
    expect(assignment).toBeUndefined();
  });

  it("每套字体的下载地址都是 https，中文那套取的是过得了 16 MiB 闸的子集版", () => {
    for (const font of PSD_FONT_PLAN) expect(font.url).toMatch(/^https:\/\//);
    const cjk = PSD_FONT_PLAN.find(font => font.postScriptName === "NotoSansSC-Regular");
    // Sans/OTC 那份 18.6 MB 过不了 MAX_FONT_BYTES，换过去只会每次启动下 18 MB
    // 再被脚本当场拒绝。见 docs/psd-text-layers.md §5.4 的体积表。
    expect(cjk.url).toContain("Sans/SubsetOTF/SC/NotoSansSC-Regular.otf");
  });
});

// 灌错租户 = 灌了个寂寞：索引是租户级的，本地前端只会去 u1 那张表里找。
it("默认租户与 web-psd 硬编码的那个用户一致", async () => {
  const source = await readFile(join(ROOT, "packages", "web-psd", "src", "doc-controller.ts"), "utf8");
  const match = /export const USER = "([^"]+)"/.exec(source);
  expect(match).not.toBeNull();
  expect(DEFAULT_FONT_TENANT).toBe(match[1]);
});

describe("ensurePsdFonts", () => {
  it("索引里两套都在时跳过，一次下载、一次写都不发", async () => {
    const fetchImpl = recordingFetch({
      [FONTS_URL]: indexResponse(PSD_FONT_PLAN.map(font => indexEntry(font.postScriptName))),
    });
    const downloaded = [];
    const seeded = [];
    const lines = [];
    // 仓库根是个空临时目录：字体文件一个都不在。索引齐了就该跳过，
    // "文件不在"根本不该被看一眼。
    const result = await ensurePsdFonts({
      root: await tempRoot(),
      credentials,
      kit,
      fetchImpl,
      download: font => downloaded.push(font.postScriptName),
      seed: config => seeded.push(config),
      log: line => lines.push(line),
      warn: line => lines.push(line),
    });

    expect(result.status).toBe("ready");
    expect(downloaded).toEqual([]);
    expect(seeded).toEqual([]);
    // 只有读索引那一次 GET。多出任何一次请求都说明"跳过"没跳干净。
    expect(fetchImpl.calls).toEqual([{ method: "GET", url: FONTS_URL }]);
    expect(lines.join("\n")).toMatch(/字体索引已就绪/);
  });

  it("索引缺一套时只灌缺的那一套，且只下缺文件的那一套", async () => {
    const root = await tempRoot();
    const plan = [
      { postScriptName: "A-Regular", file: "fonts/A.ttf", url: "https://example.invalid/A.ttf" },
      { postScriptName: "B-Regular", file: "fonts/B.otf", url: "https://example.invalid/B.otf" },
      { postScriptName: "C-Regular", file: "fonts/C.otf", url: "https://example.invalid/C.otf" },
    ];
    // B 的文件已经在本地了（上一次跑下过、只是当时没灌成）——不该再下一遍。
    await mkdir(join(root, "fonts"), { recursive: true });
    await writeFile(join(root, "fonts", "B.otf"), TEST_FONT);

    const fetchImpl = recordingFetch({ [FONTS_URL]: indexResponse([indexEntry("A-Regular")]) });
    const downloaded = [];
    let seededConfig;
    const result = await ensurePsdFonts({
      root,
      credentials,
      kit,
      plan,
      fetchImpl,
      download: font => { downloaded.push(font.postScriptName); },
      seed: ({ config }) => { seededConfig = config; },
      log: () => {},
      warn: () => {},
    });

    expect(result).toEqual({ status: "seeded", registered: ["B-Regular", "C-Regular"] });
    // A 已经在索引里 —— 既不下也不灌。B 的文件在本地 —— 灌但不下。
    expect(downloaded).toEqual(["C-Regular"]);
    expect(seededConfig.tenantId).toBe("u1");
    expect(seededConfig.fonts.map(font => font.postScriptName)).toEqual(["B-Regular", "C-Regular"]);
    // 计划里写的是相对路径，交给 seedFonts 的必须是相对**仓库根**解释出来的绝对路径。
    expect(seededConfig.fonts[0].file).toBe(join(root, "fonts", "B.otf"));
  });

  // 判据是 postScriptName —— PSD 文字层按它找字体。拿 family 去比的话，一条
  // family 恰好撞上计划名字的条目会让整套字体被当成"已经有了"，索引里却根本
  // 没有那个 postScriptName：setText 每次都取不到字形，而且不报错。
  it("按 postScriptName 判定有没有，不看 family", async () => {
    const plan = [{ postScriptName: "A-Regular", file: "fonts/A.ttf", url: "https://example.invalid/A.ttf" }];
    const fetchImpl = recordingFetch({
      [FONTS_URL]: indexResponse([indexEntry("Something-Else", "A-Regular")]),
    });
    let seededConfig;
    const result = await ensurePsdFonts({
      root: await tempRoot(),
      credentials,
      kit,
      plan,
      fetchImpl,
      download: () => {},
      seed: ({ config }) => { seededConfig = config; },
      log: () => {},
      warn: () => {},
    });
    expect(result.status).toBe("seeded");
    expect(seededConfig.fonts.map(font => font.postScriptName)).toEqual(["A-Regular"]);
  });

  it("灌到 UNIDOCS_PSD_FONT_TENANT 指定的租户", async () => {
    const url = `${PSD_URL}/tenants/acme/fonts`;
    const fetchImpl = recordingFetch({ [url]: indexResponse([]) });
    let seededConfig;
    await ensurePsdFonts({
      root: await tempRoot(),
      credentials,
      kit,
      tenantId: "acme",
      plan: [{ postScriptName: "A-Regular", file: "fonts/A.ttf", url: "https://example.invalid/A.ttf" }],
      fetchImpl,
      download: () => {},
      seed: ({ config }) => { seededConfig = config; },
      log: () => {},
      warn: () => {},
    });
    expect(fetchImpl.calls[0].url).toBe(url);
    expect(seededConfig.tenantId).toBe("acme");
  });
});

// 这一组是整条功能的安全带：开发环境因为字体下不下来就起不来，是不可接受的。
describe("失败一律不阻断启动", () => {
  const cases = [
    ["读索引失败（psd worker 没起来 / 凭据不对）", "fetch failed 读索引", async () => ({
      root: await tempRoot(),
      fetchImpl: async () => { throw new TypeError("fetch failed 读索引"); },
      download: () => {},
      seed: () => {},
    })],
    ["下载失败（没网）", "getaddrinfo ENOTFOUND github.com", async () => ({
      root: await tempRoot(),
      fetchImpl: recordingFetch({ [FONTS_URL]: indexResponse([]) }),
      download: async () => { throw new Error("下载 NotoSans-Regular 失败：getaddrinfo ENOTFOUND github.com"); },
      seed: () => {},
    })],
    ["预置失败（CAS 写不进去）", "登记 NotoSans-Regular 失败 500：boom", async () => ({
      root: await tempRoot(),
      fetchImpl: recordingFetch({ [FONTS_URL]: indexResponse([]) }),
      download: () => {},
      seed: async () => { throw new Error("登记 NotoSans-Regular 失败 500：boom"); },
    })],
  ];

  it.each(cases)("%s：返回 failed 而不是抛", async (_label, reason, build) => {
    const warnings = [];
    const setup = await build();
    const result = await ensurePsdFonts({
      credentials,
      kit,
      log: () => {},
      warn: line => warnings.push(line),
      ...setup,
    });
    expect(result.status).toBe("failed");
    const warning = warnings.join("\n");
    // 原因本身必须在警告里。少了它,用户看到的是一句"没成功"加三条通用建议 ——
    // 到底是没网、凭据不对还是 CAS 挂了,一个字都没有。
    expect(warning).toContain(reason);
    // 另外三件事：这次少了什么功能、怎么手工补、怎么彻底关掉。
    expect(warning).toMatch(/setText/);
    expect(warning).toMatch(/seed-psd-fonts\.mjs/);
    expect(warning).toMatch(/--fonts off/);
  });

  // 两个栈各写各的一份凭据(LOCAL_CREDENTIALS_PATHS)。手工补那条命令不带
  // `--credentials` 的话,操作者会拿 Cloudflare 那一份去灌 Azure —— 而那不会
  // 报错,只会把字体登记进另一个栈的表,本栈的索引照样是空的。
  it("警告里那条手工命令指向本次真正用的那份凭据", async () => {
    const root = await tempRoot();
    const warnings = [];
    const result = await ensurePsdFonts({
      root,
      credentialsPath: join(root, ".azure-runtime", "local-credentials.json"),
      kit,
      fetchImpl: async () => { throw new TypeError("fetch failed 读索引"); },
      download: () => {},
      seed: () => {},
      log: () => {},
      warn: line => warnings.push(line),
    });
    expect(result.status).toBe("failed");
    expect(warnings.join("\n"))
      .toContain("--credentials .azure-runtime/local-credentials.json");
  });

  it("凭据文件不存在也只是警告", async () => {
    const warnings = [];
    const result = await ensurePsdFonts({
      root: await tempRoot(),
      credentialsPath: join(await tempRoot(), "nope.json"),
      kit,
      fetchImpl: async () => { throw new Error("should not be reached"); },
      log: () => {},
      warn: line => warnings.push(line),
    });
    expect(result.status).toBe("failed");
    expect(warnings.join("\n")).toMatch(/PSD 字体自动预置没成功/);
  });
});

describe("downloadFont", () => {
  async function fontsDir() {
    return join(await tempRoot(), "fonts");
  }

  it("落盘的字体要过一遍与手工预置同一套校验", async () => {
    const file = join(await fontsDir(), "test.ttf");
    await downloadFont(
      { postScriptName: TEST_PS_NAME, file, url: "https://example.invalid/f.ttf" },
      { kit, fetchImpl: async () => new Response(TEST_FONT), log: () => {} },
    );
    expect(new Uint8Array(await readFile(file))).toEqual(TEST_FONT);
  });

  // 拿到的字节解析出来是另一个名字 —— 登记进去会得到一条永远选不中的条目，
  // 而回退链点的是计划里那个名字。必须当场拒绝。
  it("名字对不上就拒绝，并且不留下半个文件", async () => {
    const dir = await fontsDir();
    const file = join(dir, "noto.ttf");
    await expect(downloadFont(
      { postScriptName: "NotoSans-Regular", file, url: "https://example.invalid/f.ttf" },
      { kit, fetchImpl: async () => new Response(TEST_FONT), log: () => {} },
    )).rejects.toThrow(/没通过校验.*解析出来的是 "UnidocsTestFontRegular"/s);
    // .part 也要清掉：一个"存在但不能用"的文件比没有文件更难查。
    expect(await readdir(dir)).toEqual([]);
  });

  it("半截字节解析不了，同样拒绝且不留下半个文件", async () => {
    const dir = await fontsDir();
    const file = join(dir, "half.ttf");
    await expect(downloadFont(
      { postScriptName: TEST_PS_NAME, file, url: "https://example.invalid/f.ttf" },
      { kit, fetchImpl: async () => new Response(TEST_FONT.slice(0, 128)), log: () => {} },
    )).rejects.toThrow(/没通过校验/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("HTTP 错误带上状态码和地址", async () => {
    const file = join(await fontsDir(), "x.ttf");
    await expect(downloadFont(
      { postScriptName: TEST_PS_NAME, file, url: "https://example.invalid/f.ttf" },
      { kit, fetchImpl: async () => new Response("nope", { status: 404 }), log: () => {} },
    )).rejects.toThrow(/下载 UnidocsTestFontRegular 失败 404（https:\/\/example\.invalid\/f\.ttf）/);
  });
});
