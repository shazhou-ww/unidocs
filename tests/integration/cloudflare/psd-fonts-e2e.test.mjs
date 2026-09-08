/**
 * 字体预置的端到端：真 workerd 里跑一遍"字节写进 CAS → 元数据登记进租户级
 * `PsdFonts` DO → 读回来"，用的就是 `scripts/seed-psd-fonts.mjs` 自己那条路径。
 *
 * 为什么必须是端到端而不是拿假 fetch 拼：这条链上每一环都有一个"只有真服务才
 * 认得出来"的约束 —— 凭据要签成 `sessions:create` 且带 sessionId（签发器的
 * `validatePermissionSet` 要求）、CAS 的写要带 refDomain 才允许写根引用、
 * `coverage` 的形状要过 DO 的校验。假 fetch 只会把我对这些约束的想象测一遍。
 *
 * 凭据在这里自签：脚本本来就绕过 gateway（`/tenants/{t}/fonts` 和 CAS 的
 * root-refs 都不在 gateway 的路由表里，见脚本头部注释），所以测试也照它的方式
 * 拿 `runtime.capabilityFixture` / `runtime.stackFixture` 现签 —— 与
 * `tests/integration/azure/azure-multi-replica.test.mjs` 直连副本时同一套做法。
 *
 * 灌进去的那几套字体是在内存里现造的（`packages/doctype-psd/tests/text-test-font.ts`）：
 * CI 上没有系统字体，而"部署者自备的全量字体"按裁定 R19 仍然不进仓库。仓库里现在
 * **有**字体二进制了 —— `packages/fonts-builtin/fonts/` 下那两套随包发行的默认字体
 * （R19 于 2026-09-08 收窄为"只许提交有公开字表依据的子集"）。它们是下面
 * 「零配置」那两条用例的被测对象，不是这里灌的对象：内置字节随包走、不进 CAS，
 * 灌这个动作对它们无从谈起。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import {
  countCjkCodePoints,
  createDocTokenFactory,
  fontsUrlFor,
  readFontIndex,
  seedFonts,
} from "../../../scripts/seed-psd-fonts.mjs";
import { ensurePsdFonts, psdFontFallbacks } from "../../../scripts/psd-font-bootstrap.mjs";
import * as kit from "../../../scripts/psd-fonts-kit.ts";
import { casReadPermission, casWritePermission } from "../../../packages/service-auth/src/index.ts";
import { buildRectFont } from "../../../packages/doctype-psd/tests/text-test-font.ts";
import { casFontBytes, createFontRegistry } from "../../../packages/doctype-server-common/src/index.ts";
import {
  BUILTIN_FALLBACKS,
  BUILTIN_FONTS,
  createBuiltinFontProvider,
} from "../../../packages/fonts-builtin/src/index.ts";
import { createSetTextTool } from "../../../packages/doctype-psd/src/text/set-text.ts";
import { runQuery } from "../../../packages/doctype-psd/src/queries.ts";
import { memCas } from "../../../packages/doctype-psd/tests/helpers/mem-cas.ts";

let runtime;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
}, 60_000);

const PORTS = { gateway: 33987, psd: 33988, admin: 33992, mockOidc: 33993, edge: 33994 };
const TENANT = "alice";

/**
 * 两套字体的字节,**模块级只造一次**。
 *
 * 不能写成函数每次现造:opentype.js 序列化时把 `Date.now()` 写进 head 表的
 * created/modified(以及跟着变的 checkSumAdjustment),两次调用跨过一个秒边界
 * 就得到不同的字节。写文件用一次、断言又调一次的话,那条"CAS 里取回来的字节
 * 和源文件一致"会随机变红 —— 实测复现过。
 */
const LATIN_FONT = buildRectFont([{ char: "A", width: 500, height: 700, advanceWidth: 600 }]);

/** 带三个汉字的一套 —— "中文兜底真的带了中文"这条断言需要一个真的有 CJK 覆盖的字体。 */
const CJK_FONT = buildRectFont([
  { char: "中", width: 900, height: 900, advanceWidth: 1000 },
  { char: "文", width: 900, height: 900, advanceWidth: 1000 },
  { char: "字", width: 900, height: 900, advanceWidth: 1000 },
]);

function credentialsOf() {
  return {
    psdUrl: runtime.urls.psd,
    casOrigin: runtime.urls.edge,
    docAudience: "unidocs-doc:psd",
    doc: {
      issuer: runtime.capabilityFixture.issuer,
      kid: runtime.capabilityFixture.kid,
      privateKeyPkcs8: runtime.capabilityFixture.privateKeyPkcs8,
    },
    stack: {
      stackId: runtime.stackFixture.stackId,
      issuer: runtime.stackFixture.issuer,
      audience: runtime.stackFixture.audience,
      kid: runtime.stackFixture.kid,
      privateKeyPkcs8: runtime.stackFixture.privateKeyPkcs8,
      refDomain: "doc",
    },
  };
}

/** 一个带 cas:read 的客户端,用来验证登记下来的哈希真的能取回字体字节。
 *  脚本自己只签 cas:write（够用即止），读是测试这边额外要的。 */
async function readingBlobClient() {
  const issuer = await kit.createPkcs8CapabilityIssuer({
    issuer: runtime.stackFixture.issuer,
    kid: runtime.stackFixture.kid,
    privateKeyPkcs8: runtime.stackFixture.privateKeyPkcs8,
  });
  return kit.createCasBlobClient(kit.createTenantCasClient({
    baseUrl: runtime.urls.edge,
    stackId: runtime.stackFixture.stackId,
    tenantId: TENANT,
    getToken: () => issuer.issue({
      subject: "test:psd-fonts",
      audience: runtime.stackFixture.audience,
      tenantId: TENANT,
      refDomain: "doc",
      permissions: [casReadPermission(TENANT), casWritePermission(TENANT)],
    }),
  }));
}

async function writeFontFiles(entries) {
  const dir = await mkdtemp(join(tmpdir(), "unidocs-fonts-"));
  const fonts = [];
  for (const [name, bytes] of entries) {
    const file = join(dir, `${name}.ttf`);
    await writeFile(file, bytes);
    fonts.push({ postScriptName: "UnidocsTestFontRegular", family: "UnidocsTestFont", file });
  }
  return { dir, fonts };
}

test("seeds fonts into the tenant index and reads them back", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });

  // 两套字体登记成两个不同的名字。造出来的字体 postScriptName 都是
  // "UnidocsTestFontRegular"，而脚本会拒绝名字对不上的条目 —— 所以这里只能
  // 用同一个名字登记一套。第二套换名字要换 familyName，测试字体构造器不给
  // 那个自由度，于是改成分两次跑：一次拉丁、一次 CJK 顶替它。
  const latin = await writeFontFiles([["latin", LATIN_FONT]]);
  const credentials = credentialsOf();
  const lines = [];
  const first = await seedFonts({
    kit,
    config: { tenantId: TENANT, fonts: latin.fonts },
    credentials,
    log: line => lines.push(line),
  });

  expect(first.registered).toEqual(["UnidocsTestFontRegular"]);
  expect(first.index).toHaveLength(1);
  const latinEntry = first.index[0];
  expect(latinEntry.unitsPerEm).toBe(1000);
  expect(latinEntry.coverage).toEqual([[0x41, 0x41]]);
  expect(latinEntry.hash).toMatch(/^[0-9a-f]{64}$/);
  // 一套只有拉丁字母的索引必须让操作者看见"这里没有中文"。
  expect(lines.join("\n")).toMatch(/没有任何一套字体覆盖 CJK/);

  // 登记下来的哈希不是随便一个 64 位十六进制:它在 CAS 里真的对应那份字体字节。
  const blobs = await readingBlobClient();
  const handle = await blobs.openBlob(latinEntry.hash);
  expect(handle.ref.size).toBe(LATIN_FONT.length);
  const stored = await handle.readBytes({ offset: 0, length: handle.ref.size });
  expect(new Uint8Array(stored)).toEqual(LATIN_FONT);

  // 根引用必须钉住。不钉的后果不是报错而是静默失效:租约最长 24 小时,过期后
  // GC 收走字节,索引指向的哈希就取不回任何东西了。
  const retained = await runtime.storage.middlewareRetainedRoots(
    runtime.stackFixture.stackId,
    TENANT,
  );
  expect(retained).toEqual([{ hash: latinEntry.hash, count: 1 }]);

  // 幂等:同一份配置再跑一遍,索引不变(DO 用的是 INSERT OR REPLACE)。
  const again = await seedFonts({
    kit,
    config: { tenantId: TENANT, fonts: latin.fonts },
    credentials,
    log: () => {},
  });
  expect(again.index).toEqual(first.index);
  // 幂等也包括根引用:重跑不该把计数顶到 2(requestId 里带了哈希,CAS 认得出是同一次请求)。
  expect(await runtime.storage.middlewareRetainedRoots(runtime.stackFixture.stackId, TENANT))
    .toEqual([{ hash: latinEntry.hash, count: 1 }]);

  // 换一份字节、同一个名字:替换,不是报冲突;哈希跟着变,旧的那份被释放。
  const cjk = await writeFontFiles([["cjk", CJK_FONT]]);
  const replacedLines = [];
  const replaced = await seedFonts({
    kit,
    config: { tenantId: TENANT, fonts: cjk.fonts },
    credentials,
    log: line => replacedLines.push(line),
  });
  // 反过来也要成立:装了 CJK 字体就**不能**再报这句。只有正向断言的话,把条件
  // 改成恒真照样全绿,而一条每次都响的警告等于没有警告 —— 操作者会学会无视它,
  // "中文兜底真的带了中文"这个唯一看得见的判据也就跟着没了。
  expect(replacedLines.join("\n")).not.toMatch(/没有任何一套字体覆盖 CJK/);
  expect(replaced.index).toHaveLength(1);
  expect(replaced.index[0].hash).not.toBe(latinEntry.hash);
  expect(replaced.index[0].coverage).toEqual([[0x4e2d, 0x4e2d], [0x5b57, 0x5b57], [0x6587, 0x6587]]);
  expect(countCjkCodePoints(replaced.index[0].coverage)).toBe(3);
  // 顶掉的那份不能一直占着 5-20 MB:新的钉住、旧的放掉,一进一出。
  expect(await runtime.storage.middlewareRetainedRoots(runtime.stackFixture.stackId, TENANT))
    .toEqual([{ hash: replaced.index[0].hash, count: 1 }]);
}, 180_000);

/**
 * 换回上一个版本的字体，根引用必须重新钉上。
 *
 * 这条守的是一种只有跑到第三遍才露头的失效：CAS 的 root-ref 幂等记录是**永久**的
 * （`cas_root_ref_requests` 没有任何 prune），所以只要 requestId 是从"租户+字体名+
 * 哈希"算出来的定值，"A → B → 换回 A"第三遍就会撞上第一遍那条记录、幂等空转，
 * hashA 的根引用停在 0。索引里明明白白登记着 hashA、脚本也打印了 registered，
 * 但 24 小时租约一过 GC 就把字节收走，索引指向空气 —— 而且再跑多少遍都补不回来。
 *
 * 所以这里要跑满两个来回：只跑到第三遍的话，"把 (旧哈希 → 新哈希) 编进 requestId"
 * 这种"只推迟一个来回"的修法也能装成绿的（它在第四遍才撞上）。
 */
test("switching a font back to a previous version re-pins its root ref", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const credentials = credentialsOf();
  const latin = await writeFontFiles([["latin", LATIN_FONT]]);
  const cjk = await writeFontFiles([["cjk", CJK_FONT]]);
  const seed = fonts => seedFonts({ kit, config: { tenantId: TENANT, fonts }, credentials, log: () => {} });
  const roots = () => runtime.storage.middlewareRetainedRoots(runtime.stackFixture.stackId, TENANT);

  const hashA = (await seed(latin.fonts)).index[0].hash;
  expect(await roots()).toEqual([{ hash: hashA, count: 1 }]);

  const hashB = (await seed(cjk.fonts)).index[0].hash;
  expect(hashB).not.toBe(hashA);
  expect(await roots()).toEqual([{ hash: hashB, count: 1 }]);

  // 第三遍：换回 A。索引回到 hashA，根引用也必须跟着回到 hashA。
  expect((await seed(latin.fonts)).index[0].hash).toBe(hashA);
  expect(await roots()).toEqual([{ hash: hashA, count: 1 }]);

  // 第四、五遍：再来一个来回。
  await seed(cjk.fonts);
  expect(await roots()).toEqual([{ hash: hashB, count: 1 }]);
  await seed(latin.fonts);
  expect(await roots()).toEqual([{ hash: hashA, count: 1 }]);
}, 180_000);

test("a font whose postScriptName disagrees with the file is refused before anything is written", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const { fonts } = await writeFontFiles([["latin", LATIN_FONT]]);
  const mislabelled = [{ ...fonts[0], postScriptName: "NotoSansSC-Regular" }];

  await expect(seedFonts({
    kit,
    config: { tenantId: TENANT, fonts: mislabelled },
    credentials: credentialsOf(),
    log: () => {},
  })).rejects.toThrow(/配置里写的是 "NotoSansSC-Regular"/);

  // "什么都没写进去"才是这条测试的重点:解析在前、写在后。
  const empty = await seedFonts({
    kit,
    config: { tenantId: TENANT, fonts: [] },
    credentials: credentialsOf(),
    log: () => {},
  });
  expect(empty.index).toEqual([]);
}, 180_000);

/**
 * `pnpm dev` 启动时那一步（`ensurePsdFonts`）对着真 worker 跑一遍。
 *
 * 单测把 `seed` 换成了探针，所以"灌"这个动作真的落到 DO 和 CAS 上、以及
 * "第二遍什么都不写"，只有这里守得住。用的是现造的测试字体、`download` 传一个
 * 一调就炸的桩：这条链不该在文件已经躺在本地时碰网络（CI 上也没有网）。
 */
test("startup bootstrap seeds an empty index once and then leaves it alone", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const { dir } = await writeFontFiles([["latin", LATIN_FONT]]);
  // 计划里的 file 是相对仓库根的；这里把临时目录当仓库根。
  const plan = [{
    postScriptName: "UnidocsTestFontRegular",
    file: "latin.ttf",
    url: "https://example.invalid/latin.ttf",
  }];
  const bootstrap = (log = () => {}) => ensurePsdFonts({
    root: dir,
    credentials: credentialsOf(),
    tenantId: TENANT,
    plan,
    kit,
    download: () => { throw new Error("字体文件就在本地，不该发起下载"); },
    log,
    warn: log,
  });
  const roots = () => runtime.storage.middlewareRetainedRoots(runtime.stackFixture.stackId, TENANT);
  const requestIds = () => runtime.storage.middlewareRootRefRequestIds(runtime.stackFixture.stackId, TENANT);

  const first = await bootstrap();
  expect(first).toEqual({ status: "seeded", registered: ["UnidocsTestFontRegular"] });
  const pinned = await roots();
  expect(pinned).toHaveLength(1);
  const idsAfterSeed = await requestIds();

  // 回退链的默认值必须是**索引里真有的那个名字** —— 家族名写进去不会报错，
  // 只会让回退链静默失效。索引里的名字是 describeFont 从字体文件解析出来的。
  const index = await readFontIndex({
    fontsUrl: fontsUrlFor(credentialsOf(), TENANT),
    docToken: await createDocTokenFactory(kit, credentialsOf(), TENANT),
  });
  expect(psdFontFallbacks(plan).split(",")).toEqual(index.map(entry => entry.postScriptName));

  // 第二遍：索引里已经有了，就该一个字节都不写。根引用的幂等记录是永久的，
  // 多写一次就会在这里多出一条 —— 那是"跳过没跳干净"最直接的证据。
  const lines = [];
  expect(await bootstrap(line => lines.push(line))).toEqual({ status: "ready", registered: [] });
  expect(await requestIds()).toEqual(idsAfterSeed);
  expect(await roots()).toEqual(pinned);
  expect(lines.join("\n")).toMatch(/字体索引已就绪/);
}, 180_000);

/**
 * `bindingDefaults` 真的落到了 unidocs-psd 上。
 *
 * 它守的**不再**是"缺了这个绑定中文就画不出来" —— 那条已经由
 * `@unidocs/fonts-builtin` 的 `BUILTIN_FALLBACKS` 兜住了（`scripts/dev.mjs`
 * 也因此不再传这个值，见 `tests/unit/scripts/psd-font-bootstrap.test.mjs`）。
 * 它守的是 `startLocalRuntime({ bindingDefaults })` 这条**接线**本身：调用方
 * 想覆盖回退链时，值确实到得了 worker 手上。
 */
test("the dev runtime hands the psd worker a font fallback chain", async () => {
  runtime = await startLocalRuntime({
    docTypes: ["psd"],
    ports: PORTS,
    bindingDefaults: { psd: { PSD_FONT_FALLBACKS: psdFontFallbacks() } },
  });
  const bindings = await runtime.mf.getBindings("unidocs-psd");
  expect(bindings.PSD_FONT_FALLBACKS).toBe("NotoSans-Regular,NotoSansSC-Regular");
}, 180_000);

// ---------------------------------------------------------------------------
// 零配置：内置字体这一档
// ---------------------------------------------------------------------------

const BUILTIN_FONTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "packages", "fonts-builtin", "fonts",
);

/** Node 侧的内置字节加载器。与 `packages/azure-psd/src/builtin-fonts.ts` 同一个
 *  语义（按 `fonts/` 下的文件名读），这里直接给目录，不重跑那边的定位逻辑 ——
 *  定位逻辑由 `packages/azure-psd/tests/builtin-fonts.test.ts` 守着。 */
const builtinLoader = async fileName =>
  new Uint8Array(await readFile(join(BUILTIN_FONTS_DIR, fileName)));

/**
 * 生产接线的复刻：`[内置, 租户]` 两个来源，顺序即优先级（后者按 postScriptName
 * 盖掉前者）—— 与 `packages/cloudflare-psd/src/agent-deps.ts` 和
 * `packages/azure-psd/src/agent-deps.ts` 里那两处逐条对应。
 *
 * 租户那一档在这里是**真的**：`list` 打的是跑着的 worker 上那个
 * `/tenants/{t}/fonts`，`read`/`blobFor` 用的是中立层的 `casFontBytes` ——
 * 与两个平台适配器用的是同一个常量，不是这里手搓一套语义。
 */
function registryFor(credentials, docToken) {
  const fontsUrl = fontsUrlFor(credentials, TENANT);
  return createFontRegistry({
    providers: [
      createBuiltinFontProvider({ load: builtinLoader }),
      {
        id: "tenant",
        list: () => readFontIndex({ fontsUrl, docToken }),
        read: casFontBytes.read,
        blobFor: casFontBytes.blobFor,
      },
    ],
  });
}

/** 一个带文字层的最小文档。字号 64 是为了让 8105 字子集里的汉字轮廓落在若干
 *  个像素上而不是亚像素 —— 这条用例断言的是"排得出来",不是精确版面。 */
function textDocument(content) {
  const bounds = [0, 0, 200, 1200];
  return {
    canvas: { width: 1400, height: 400, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [{
      id: "title", type: "text", name: "title", bounds,
      opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 1200, height: 200, data: new Uint8ClampedArray(1200 * 200 * 4) },
      text: {
        content,
        // 请求的字体是拉丁那套 —— 它不覆盖 CJK，汉字必须靠回退链落到内置的中文
        // 子集上。这正是 `glyphFallbacks` 要报出来的那一档。
        style: { font: "NotoSans-Regular", size: 64, color: { r: 0, g: 0, b: 0 } },
        paragraphStyle: { justification: "left" },
      },
    }],
  };
}

/** 跑一次真的 setText effect。ctx 照 `packages/doctype-psd/tests/set-text.test.ts`
 *  的 `effectCtx` 手搓：query 走真的 runQuery，blob 读写走同一个 memCas。 */
async function runSetText(registry, fallbacks, model, cas, args) {
  const tool = createSetTextTool({ registry, fallbacks });
  if (tool.kind !== "effect") throw new Error("setText must be an effect tool");
  const out = await tool.run(args, {
    query: async q => ({ data: await runQuery(q, model, cas.ctx), version: 1 }),
    readBlob: async blob => {
      const handle = await cas.ctx.openSBlob(blob);
      return {
        data: await handle.readBytes({ offset: 0, length: handle.size }),
        contentType: handle.contentType,
      };
    },
    writeBlob: data => cas.ctx.makeSBlob(data),
    signal: AbortSignal.timeout(120_000),
  });
  return { ops: out.ops, structured: out.result.structuredContent };
}

/**
 * **本次重构的核心断言**：新环境、新租户，不灌任何字体，`setText` 就把中英混排
 * 排得出来。
 *
 * 为什么它不空转 —— 三条断言各挡一种"看起来绿了其实什么都没排出来"：
 *
 *  1. `structured.missing` 是 `laid.missing`，装的是**一个 face 都认不出来的
 *     码位**。内置的中文子集缺了、坏了、或者压根没被 registry 合进来，"你好"
 *     两个字就会出现在这里 —— 所以 `toEqual([])` 是有内容的。
 *  2. `structured.glyphFallbacks` 精确说出"哪几个字最后是用哪套字体排的"。它必须
 *     点名 `NotoSans-Regular → NotoSansSC-Regular` 并带上那几个汉字：光有
 *     "missing 为空"还可能是因为汉字被整段跳过了，而这一条要求它们真的被某个
 *     face 认领。
 *  3. 文件末尾那条负向对照（只留拉丁那一档）把同一段字排一遍，`missing` 里必须
 *     出现"你""好"。没有它的话，上面两条在"实现改成永远返回空数组"时照样全绿。
 *
 * 另外断言 `fonts` 为空：内置来源的 `blobFor` 恒为 null，字节不在 CAS 里，
 * 写进 `doc.fonts` 会撞上 state.ts 的 "was not stored during externalization"。
 */
test("零配置：一个从没灌过字体的租户，setText 仍然把中英混排排得出来", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const credentials = credentialsOf();
  const docToken = await createDocTokenFactory(kit, credentials, TENANT);

  // 前提：真 workerd 上，这个租户的登记表是空的 —— 这条用例没有灌过任何东西。
  expect(await readFontIndex({ fontsUrl: fontsUrlFor(credentials, TENANT), docToken })).toEqual([]);

  const registry = registryFor(credentials, docToken);
  const index = await registry.index();
  expect([...index.keys()]).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  expect([...index.values()].map(font => font.source)).toEqual(["builtin", "builtin"]);

  const cas = memCas();
  const model = textDocument("Hello");
  const { ops, structured } = await runSetText(
    registry, BUILTIN_FALLBACKS, model, cas,
    { layerId: "title", text: "你好 UniDocs 2026" },
  );

  expect(structured.ok).toBe(true);
  // 一个字都不能落下。
  expect(structured.missing).toEqual([]);
  // 汉字确实是内置的中文子集排的，不是被跳过的。
  expect(structured.glyphFallbacks).toEqual([{
    requested: "NotoSans-Regular",
    used: "NotoSansSC-Regular",
    chars: ["你", "好"],
  }]);

  expect(ops).toHaveLength(1);
  const payload = ops[0].payload;
  expect(payload.text.content).toBe("你好 UniDocs 2026");
  // 墨迹包围盒是从真实字形轮廓算出来的（宽或高为 0 时 effect 直接 fail），
  // 所以这两个正数就是"真的排出了墨迹"。
  expect(payload.pixels.width).toBeGreaterThan(0);
  expect(payload.pixels.height).toBeGreaterThan(0);
  // 栅格化结果真的落进了 CAS，且是一张 PNG（`\x89PNG`）。
  const handle = await cas.ctx.openSBlob(payload.pixels.blob);
  expect(handle.contentType).toBe("image/png");
  expect([...await handle.readBytes({ offset: 0, length: 4 })]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  // 内置字体不进 doc.fonts —— 没有可回收的对象，也就没有要保活的东西。
  expect(payload.fonts).toEqual([]);
}, 180_000);

/**
 * 负向对照。上一条的 `missing: []` 必须是被中文子集挣来的，不是恒真。
 *
 * 只留拉丁那一档（回退链也只剩它），同一段字再排一遍："你""好"必须出现在
 * `missing` 里。这条一旦跟着上一条一起变绿，说明断言写在了实现的返回值上、
 * 而不是写在"字体覆盖"这个约束上。
 */
test("负向对照：只留拉丁那一档，汉字就落进 missing", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const latinOnly = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSans-Regular");
  const registry = createFontRegistry({
    providers: [{
      id: "builtin",
      list: async () => [latinOnly.entry],
      read: async () => await builtinLoader(latinOnly.file),
      blobFor: () => null,
    }],
  });

  const cas = memCas();
  const { structured } = await runSetText(
    registry, ["NotoSans-Regular"], textDocument("Hello"), cas,
    { layerId: "title", text: "你好 UniDocs 2026" },
  );

  expect(structured.ok).toBe(true);
  expect(structured.missing).toEqual(["你", "好"]);
  expect(structured.glyphFallbacks).toEqual([]);
}, 180_000);

/**
 * 覆盖可覆盖：装一套同名字体，索引里那条的来源从内置变成租户。
 *
 * 灌的就是内置那份拉丁字节本身 —— `psd-font-bootstrap.mjs` 的计划里，拉丁那套
 * 眼下与内置同为全量、同一个哈希，所以这是**真实的**线上形态，不是为了测试凑的。
 * 正因为哈希相同，这里不能只断言 `source` 这个标签：还要断言 `blobFor` 从 null
 * 变成了一个真的 SBlob —— 那是行为上的差别（文档靠它把 CAS 里那份字节钉住），
 * 也是"这条真的换了来源"的唯一硬证据。
 */
test("装一套同名字体：索引里那条的 source 从 builtin 变成 tenant", async () => {
  runtime = await startLocalRuntime({ docTypes: ["psd"], ports: PORTS });
  const credentials = credentialsOf();
  const docToken = await createDocTokenFactory(kit, credentials, TENANT);

  const before = await registryFor(credentials, docToken).index();
  expect(before.get("NotoSans-Regular").source).toBe("builtin");
  expect(registryFor(credentials, docToken).blobFor(before.get("NotoSans-Regular"))).toBeNull();

  const latin = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSans-Regular");
  const seeded = await seedFonts({
    kit,
    config: {
      tenantId: TENANT,
      fonts: [{
        postScriptName: "NotoSans-Regular",
        family: "Noto Sans",
        file: join(BUILTIN_FONTS_DIR, latin.file),
      }],
    },
    credentials,
    log: () => {},
  });
  expect(seeded.registered).toEqual(["NotoSans-Regular"]);

  // 新建一个 registry 而不是复用上面那个：`index()` 带 60 秒 TTL 缓存，复用会
  // 读到灌之前那一份 —— 那是缓存在骗人，不是覆盖没生效。
  const after = registryFor(credentials, docToken);
  const index = await after.index();
  // 中文那一档没被碰过，仍然来自内置；只有同名的那条易主。
  expect([...index.values()].map(font => font.source)).toEqual(["tenant", "builtin"]);
  const latinEntry = index.get("NotoSans-Regular");
  // 索引里那条换成了**脚本刚登记的那一条**，不只是标签变了。
  expect(latinEntry.entry.hash).toBe(seeded.index.find(e => e.postScriptName === "NotoSans-Regular").hash);
  // 两个哈希不同,尽管字节逐字节相同:内置那条的 hash 是字体字节的裸 sha256,
  // 租户那条是 CAS 的节点摘要(带规范化头)。`FontEntry.hash` 的注释说的
  // "不代表它在 CAS 里"就是这个意思 —— 这里顺带把它钉住。
  expect(latinEntry.entry.hash).not.toBe(latin.entry.hash);
  // 租户那一档给得出 SBlob（文档靠它把 CAS 里那份字节钉住）；内置那一档恒为 null。
  expect(after.blobFor(latinEntry)?.hash).toBe(latinEntry.entry.hash);
  expect(after.blobFor(index.get("NotoSansSC-Regular"))).toBeNull();
}, 180_000);
