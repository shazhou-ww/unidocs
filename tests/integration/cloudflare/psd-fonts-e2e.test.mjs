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
 * 字体是在内存里现造的（`packages/doctype-psd/tests/text-test-font.ts`），不是
 * 仓库里的字体文件：字体二进制不进仓库（裁定 R19），而 CI 上也没有系统字体。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { seedFonts, countCjkCodePoints } from "../../../scripts/seed-psd-fonts.mjs";
import * as kit from "../../../scripts/psd-fonts-kit.ts";
import { casReadPermission, casWritePermission } from "../../../packages/service-auth/src/index.ts";
import { buildRectFont } from "../../../packages/doctype-psd/tests/text-test-font.ts";

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
