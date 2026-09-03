/**
 * 把一套字体灌进某个租户的 PSD 字体索引：字节写进 CAS，元数据登记进
 * `PsdFonts` 这个租户级 Durable Object。
 *
 * PSD 文字层只记字体**名字**，不内嵌字体文件，所以 `setText` 要自己排版就得
 * 先有一张"这个名字 → CAS 里哪一坨字节 → 它认识哪些码位"的索引。这个脚本就是
 * 往那张索引里写东西的唯一入口（见 docs/psd-text-layers.md §3）。
 *
 * ## 用法
 *
 *   node scripts/seed-psd-fonts.mjs <config.json> [选项]
 *
 *     --credentials <path>  端点与签名密钥（默认见下）
 *     --psd-url <url>       覆盖凭据文件里的 psd worker 地址
 *     --cas-origin <url>    覆盖凭据文件里的 CAS 服务地址
 *
 * `config.json` 只描述**要装哪些字体**（示例见 scripts/psd-fonts.example.json）：
 *
 *   {
 *     "tenantId": "alice",
 *     "fonts": [
 *       { "postScriptName": "NotoSans-Regular",   "file": "./fonts/NotoSans-Regular.ttf" },
 *       { "postScriptName": "NotoSansSC-Regular", "file": "./fonts/NotoSansSC-Regular.otf" }
 *     ]
 *   }
 *
 * `unitsPerEm` / `coverage` / `hash` **不许写在配置里**，它们从字体文件解析出来
 * （裁定：填错了字还是那些字，位置全错）。写了会直接报错，不会被静默忽略。
 *
 * 字体二进制**不进仓库**（裁定 R19）：一套中文字体 5–20 MB，进 git 就永远留在
 * 历史里。`file` 写的是本地路径，文件由部署者自备；Noto Sans / Noto Sans SC 都是
 * OFL 许可，见 FONT_SOURCE_HINT。
 *
 * ## 端点与密钥（`--credentials`，默认 .wrangler/unidocs/local-credentials.json）
 *
 *   {
 *     "psdUrl":      "http://127.0.0.1:8790",
 *     "casOrigin":   "http://127.0.0.1:8794",
 *     "docAudience": "unidocs-doc:psd",
 *     "doc":   { "issuer": "…", "kid": "…", "privateKeyPkcs8": "…" },
 *     "stack": { "stackId": "…", "issuer": "…", "audience": "…", "kid": "…",
 *                "privateKeyPkcs8": "…", "refDomain": "doc" }
 *   }
 *
 * `pnpm dev`（Cloudflare 栈）每次启动都会把这份文件写出来（`writeLocalCredentials`
 * in scripts/unidocs-dev-config.mjs），因为本地运行时的两把密钥是每次现生成的。
 *
 * ## 它**不走 gateway**，这是个已知限制
 *
 * gateway 的路由表（`matchGatewayRoute`）只认 `/tenants/{t}/docs/…` 与
 * `/tenants/{t}/cas/…`，`/tenants/{t}/fonts` 落到它手里是 404。给它补一条转发
 * 规则也不够：本脚本还要调 CAS 的 `updateRootRefs` 把字体根引用钉住，而那条路由
 * gateway **有意不暴露**（root-refs 是私有服务操作，见 gateway-handler.ts 的
 * `isGatewayExposedCasRoute` 注释）。不钉住的后果不是报错而是静默失效：租约最长
 * 24 小时（`unicas-packages/service/src/node-lease.ts` 的 `MAX_LEASE_MS`），过期
 * 后 GC 收走字节，索引就指向了一堆不存在的哈希。
 *
 * 所以这是一个**部署者工具**：它直连 psd worker 和 CAS 服务，并且需要两把本该只
 * 存在 gateway 上的私钥（`CAPABILITY_PRIVATE_KEY_PKCS8` / `CAS_STACK_PRIVATE_KEY_PKCS8`，
 * 见 stacks/unidocs-cloudflare/deploy/README.md）。生产环境要用它，就得在能拿到
 * 这两把密钥、并且 psd worker 对你可达的地方跑。别把它当成终端用户接口。
 *
 * ## 写权限沿用 `sessions:create`（裁定 R41）
 *
 * 字体登记端点要的是租户作用域的 `sessions:create` —— 也就是说**能创建会话的人
 * 就能往该租户的字体表里登记字体**。这是有意为之的取舍（字体是加法，不改动既有
 * 文档），但它比看上去宽，别以为这个端点有更严的保护。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_CREDENTIALS_PATH = ".wrangler/unidocs/local-credentials.json";

/** 路径不存在时要说清楚"去哪儿拿"，不然报一句 ENOENT 等于让人自己猜。 */
export const FONT_SOURCE_HINT =
  "Noto Sans / Noto Sans SC 都是 OFL 许可，可从 https://fonts.google.com/noto 下载"
  + "（或 https://github.com/notofonts/noto-cjk 取 CJK 那套）。字体二进制不进仓库，"
  + "由部署者自备。";

/**
 * 单套字体的字节上限。
 *
 * 不是存储限制，是**读取**限制：`setText` 靠 `ctx.readBlob` 把整套字体读进内存，
 * 而编辑器 DO 的 SBlob 上下文把一次物化的上限设成了 16 MiB
 * （`packages/cloudflare-sdk/src/editor-do-svalue.ts` 的 `MAX_SVALUE_ROOT_BYTES`）。
 * 超过这个数的字体登记进去不会当场出错，只会在真正排字时抛 RangeError —— 那时
 * 用户看到的是"改字失败"，而不是"这套字体从一开始就装不下"。所以在这里拦。
 */
export const MAX_FONT_BYTES = 16 * 1024 * 1024;

/** 配置里出现这些字段就是搞错了：它们必须从字体文件解析。 */
const DERIVED_FIELDS = ["unitsPerEm", "coverage", "hash"];

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

/**
 * 解析字体清单。`configPath` 只用来把 `file` 里的相对路径解释成相对配置文件
 * 自身 —— 相对进程 CWD 会让同一份配置在不同目录下跑出不同结果。
 */
export function parseSeedConfig(text, { configPath }) {
  const config = parseJson(text, configPath);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${configPath}: 顶层必须是一个 JSON 对象`);
  }
  if (typeof config.tenantId !== "string" || config.tenantId.length === 0) {
    throw new Error(`${configPath}: tenantId 必须是非空字符串`);
  }
  if (!Array.isArray(config.fonts) || config.fonts.length === 0) {
    throw new Error(`${configPath}: fonts 必须是非空数组`);
  }
  const baseDir = dirname(resolve(configPath));
  const seen = new Set();
  const fonts = config.fonts.map((entry, index) => {
    const where = `${configPath}: fonts[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} 必须是一个 JSON 对象`);
    }
    if (typeof entry.postScriptName !== "string" || entry.postScriptName.length === 0) {
      throw new Error(`${where}.postScriptName 必须是非空字符串`);
    }
    if (typeof entry.file !== "string" || entry.file.length === 0) {
      throw new Error(`${where}.file 必须是非空字符串（字体文件的本地路径）`);
    }
    for (const field of DERIVED_FIELDS) {
      if (entry[field] !== undefined) {
        throw new Error(
          `${where}.${field} 不允许出现在配置里 —— 它必须从字体文件解析出来。`
          + "手填的值一旦和字体对不上，字还是那些字，位置全错。",
        );
      }
    }
    if (entry.family !== undefined
      && (typeof entry.family !== "string" || entry.family.length === 0)) {
      throw new Error(`${where}.family 给了就必须是非空字符串`);
    }
    if (seen.has(entry.postScriptName)) {
      throw new Error(`${where}.postScriptName 与前面的条目重复：${entry.postScriptName}`);
    }
    seen.add(entry.postScriptName);
    return Object.freeze({
      postScriptName: entry.postScriptName,
      // family 是索引里的随附元数据，排版链上没有任何东西读它（`selectFonts` /
      // `resolveFaceChain` 全按 postScriptName 索引），但 DO 要求它非空。解析器
      // 那个 `FontFace` 接口不暴露 family 名（它是上游冻结的接口），所以这里
      // 允许配置给，缺省退回 postScriptName —— 而不是为了一个没人读的字段再把
      // 整份字体多解析一遍。
      family: entry.family ?? entry.postScriptName,
      file: isAbsolute(entry.file) ? entry.file : resolve(baseDir, entry.file),
    });
  });
  return Object.freeze({ tenantId: config.tenantId, fonts: Object.freeze(fonts) });
}

/** 解析端点与签名密钥。缺任何一项都当场说出缺的是哪一项。 */
export function parseCredentials(text, { credentialsPath }) {
  const raw = parseJson(text, credentialsPath);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${credentialsPath}: 顶层必须是一个 JSON 对象`);
  }
  const requireString = (value, name) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${credentialsPath}: 缺少 ${name}`);
    }
    return value;
  };
  const doc = raw.doc ?? {};
  const stack = raw.stack ?? {};
  return Object.freeze({
    psdUrl: trimSlash(requireString(raw.psdUrl, "psdUrl")),
    casOrigin: trimSlash(requireString(raw.casOrigin, "casOrigin")),
    docAudience: requireString(raw.docAudience ?? "unidocs-doc:psd", "docAudience"),
    doc: Object.freeze({
      issuer: requireString(doc.issuer, "doc.issuer"),
      kid: requireString(doc.kid, "doc.kid"),
      privateKeyPkcs8: requireString(doc.privateKeyPkcs8, "doc.privateKeyPkcs8"),
    }),
    stack: Object.freeze({
      stackId: requireString(stack.stackId, "stack.stackId"),
      issuer: requireString(stack.issuer, "stack.issuer"),
      audience: requireString(stack.audience, "stack.audience"),
      kid: requireString(stack.kid, "stack.kid"),
      privateKeyPkcs8: requireString(stack.privateKeyPkcs8, "stack.privateKeyPkcs8"),
      // 根引用按 refDomain 分账。gateway 给 doc worker 签的 delegated CAS 凭据用的
      // 是 "doc"（`CAS_REF_DOMAIN`），字体跟着走同一个域，不另开一个。
      refDomain: typeof stack.refDomain === "string" && stack.refDomain.length > 0
        ? stack.refDomain
        : "doc",
    }),
  });
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: 不是合法的 JSON —— ${error.message}`);
  }
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// 字体文件 → 索引条目
// ---------------------------------------------------------------------------

/** 覆盖区间数组里一共有多少个码位。区间是左闭右闭的。 */
export function countCodePoints(coverage) {
  let total = 0;
  for (const [start, end] of coverage) total += end - start + 1;
  return total;
}

/**
 * 其中落在 CJK 统一表意文字基本区（U+4E00–U+9FFF）的有多少个。
 *
 * 只打总码位数说明不了"中文兜底真的带了中文"：一套只有拉丁字母加满屏 emoji 的
 * 字体，总数也能上千。这一个数字才是操作者唯一能一眼看出来的判据。
 */
export function countCjkCodePoints(coverage) {
  const [lo, hi] = [0x4e00, 0x9fff];
  let total = 0;
  for (const [start, end] of coverage) {
    const from = Math.max(start, lo);
    const to = Math.min(end, hi);
    if (from <= to) total += to - from + 1;
  }
  return total;
}

/** 按扩展名给一个 CAS 节点内容类型。只影响 CAS 里那条元数据，不参与排版。 */
function fontContentType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".ttf") || lower.endsWith(".ttc")) return "font/ttf";
  return "font/sfnt";
}

/**
 * 读一个字体文件并解析出索引需要的一切。任何一步失败都要说得出是**哪一个文件**
 * —— 一次灌十套字体时，"parse error" 四个字等于没说。
 */
export async function describeFont(kit, font) {
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(font.file));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `字体文件不存在：${font.file}（配置里的 ${font.postScriptName}）。${FONT_SOURCE_HINT}`,
      );
    }
    throw new Error(`读不了字体文件 ${font.file}：${error.message}`);
  }
  if (bytes.length > MAX_FONT_BYTES) {
    throw new Error(
      `字体文件 ${font.file} 有 ${bytes.length} 字节，超过 ${MAX_FONT_BYTES} 字节的上限。`
      + "登记进去也用不了：setText 读整套字体时会撞上编辑器 DO 的物化上限"
      + "（editor-do-svalue.ts 的 MAX_SVALUE_ROOT_BYTES）。请改用子集化过的字体。",
    );
  }
  let face;
  try {
    face = kit.parseFontFace(bytes);
  } catch (error) {
    throw new Error(`字体文件 ${font.file} 解析失败：${error.message}`);
  }
  if (face.postScriptName !== font.postScriptName) {
    throw new Error(
      `字体名对不上：配置里写的是 "${font.postScriptName}"，`
      + `${font.file} 解析出来的是 "${face.postScriptName}"。`
      + "PSD 文字层按 postScriptName 找字体，用配置里那个名字登记会得到一条永远选不中的条目。",
    );
  }
  const coverage = kit.fontCoverage(face);
  if (coverage.length === 0) {
    throw new Error(
      `字体文件 ${font.file} 一个码位都不覆盖（cmap 空）。登记它只会得到一条谁也发现不了的死条目。`,
    );
  }
  if (!Number.isInteger(face.unitsPerEm) || face.unitsPerEm <= 0) {
    throw new Error(`字体文件 ${font.file} 的 unitsPerEm 不是正整数：${face.unitsPerEm}`);
  }
  return Object.freeze({
    postScriptName: font.postScriptName,
    family: font.family,
    file: font.file,
    bytes,
    contentType: fontContentType(font.file),
    unitsPerEm: face.unitsPerEm,
    coverage: coverage.map(([start, end]) => [start, end]),
  });
}

// ---------------------------------------------------------------------------
// 灌进去
// ---------------------------------------------------------------------------

/**
 * 主流程。`kit` 由 CLI 打包出来、由测试直接 import —— 见 scripts/psd-fonts-kit.ts。
 *
 * 顺序是：全部字体先解析完，再一个都不写；然后逐套 写字节 → 钉根引用 → 登记；
 * 最后回读索引。先全解析是因为一个坏文件不该在已经灌进去半套之后才被发现。
 */
export async function seedFonts({
  kit,
  config,
  credentials,
  log = console.log,
  fetchImpl = fetch,
}) {
  const { tenantId } = config;
  const prepared = [];
  for (const font of config.fonts) {
    prepared.push(await describeFont(kit, font));
  }

  const casIssuer = await kit.createPkcs8CapabilityIssuer({
    issuer: credentials.stack.issuer,
    kid: credentials.stack.kid,
    privateKeyPkcs8: credentials.stack.privateKeyPkcs8,
  });
  const docIssuer = await kit.createPkcs8CapabilityIssuer({
    issuer: credentials.doc.issuer,
    kid: credentials.doc.kid,
    privateKeyPkcs8: credentials.doc.privateKeyPkcs8,
  });

  const cas = kit.createTenantCasClient({
    baseUrl: credentials.casOrigin,
    stackId: credentials.stack.stackId,
    tenantId,
    fetcher: { fetch: (input, init) => fetchImpl(input, init) },
    // 每次请求现签一张：凭据默认只活 120 秒，而灌一套 CJK 字体可能要好几分钟。
    getToken: () => casIssuer.issue({
      subject: "seed:psd-fonts",
      audience: credentials.stack.audience,
      tenantId,
      refDomain: credentials.stack.refDomain,
      permissions: [kit.casWritePermission(tenantId)],
    }),
  });
  const blobs = kit.createCasBlobClient(cas);

  const fontsUrl = `${credentials.psdUrl}/tenants/${encodeURIComponent(tenantId)}/fonts`;
  const docToken = () => docIssuer.issue({
    subject: "gateway",
    audience: credentials.docAudience,
    tenantId,
    // 字体索引是**租户级**的，这个端点根本不看 sessionId。但签发器要求带
    // `sessions:*` 权限的凭据必须有 sessionId（issuer.ts 的 `validatePermissionSet`），
    // 所以现编一个 —— 它不指向任何真实会话，也不会被任何东西用来定位会话。
    sessionId: `seed-psd-fonts-${crypto.randomUUID()}`,
    permissions: [kit.sessionCreatePermission(tenantId)],
  });

  const before = await readFontIndex({ fontsUrl, docToken, fetchImpl });
  const previousHash = new Map(before.map(entry => [entry.postScriptName, entry.hash]));

  const superseded = [];
  for (const font of prepared) {
    const ref = await blobs.storeBlob(new Blob([font.bytes]), {
      contentType: font.contentType,
      size: font.bytes.length,
    });
    // 钉根引用，否则字节只有一份租约（最长 24 小时），GC 一跑索引就指向空气。
    // requestId 里带上哈希：同一套字体重跑是同一个请求、幂等空转；换了字体文件
    // 就是另一个请求，不会撞上"同 requestId 不同载荷"的 409。
    await blobs.retain({
      requestId: `psd-font:${tenantId}:${font.postScriptName}:${ref.hash}`,
      references: { [ref.hash]: 1 },
    });

    const response = await fetchImpl(fontsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await docToken()}`,
      },
      body: JSON.stringify({
        postScriptName: font.postScriptName,
        family: font.family,
        hash: ref.hash,
        unitsPerEm: font.unitsPerEm,
        coverage: font.coverage,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `登记 ${font.postScriptName} 失败 ${response.status}：${await response.text()}`,
      );
    }
    const old = previousHash.get(font.postScriptName);
    if (old !== undefined && old !== ref.hash) superseded.push({ font, hash: old });
    log(`registered ${font.postScriptName}  hash=${ref.hash}  ${font.bytes.length} bytes  <- ${font.file}`);
  }

  // 回读。这一步不是走过场：登记接口返回 200 只说明请求被受理，索引里到底躺着
  // 什么、覆盖了多少码位，只有读回来才看得见。
  const index = await readFontIndex({ fontsUrl, docToken, fetchImpl });
  log("");
  log(`tenant ${tenantId} 的字体索引（${index.length} 套）：`);
  for (const entry of index) {
    const total = countCodePoints(entry.coverage);
    const cjk = countCjkCodePoints(entry.coverage);
    log(
      `  ${entry.postScriptName.padEnd(28)} upm=${String(entry.unitsPerEm).padEnd(6)}`
      + `ranges=${String(entry.coverage.length).padEnd(7)}`
      + `codepoints=${String(total).padEnd(8)}CJK(U+4E00–U+9FFF)=${cjk}`,
    );
  }
  if (index.every(entry => countCjkCodePoints(entry.coverage) === 0)) {
    log("");
    log("警告：索引里没有任何一套字体覆盖 CJK 统一表意文字 —— 中文会掉到回退链末端，一个字都画不出来。");
  }

  // 被顶掉的旧字节：登记成功之后才放，顺序反了会在中途失败时把还在用的字体收掉。
  // 尽力而为 —— 旧条目可能是别的工具登记的，那时它的根引用不在我们名下，减到负数
  // 会被 CAS 挡回来（409 NEGATIVE_AGGREGATE）。那不是这次运行的失败。
  for (const { font, hash } of superseded) {
    try {
      await blobs.release({
        requestId: `psd-font-release:${tenantId}:${font.postScriptName}:${hash}`,
        references: { [hash]: 1 },
      });
      log(`released superseded blob ${hash} (${font.postScriptName})`);
    } catch (error) {
      log(`警告：旧字体 ${hash}（${font.postScriptName}）的根引用没能释放：${error.message}`);
    }
  }

  return { registered: prepared.map(font => font.postScriptName), index };
}

async function readFontIndex({ fontsUrl, docToken, fetchImpl }) {
  const response = await fetchImpl(fontsUrl, {
    headers: { Authorization: `Bearer ${await docToken()}` },
  });
  if (!response.ok) {
    throw new Error(`读字体索引失败 ${response.status}：${await response.text()}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.fonts)) throw new Error("字体索引响应里没有 fonts 数组");
  return body.fonts;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 把 psd-fonts-kit.ts 打成一个 node 能直接 import 的 bundle。
 *
 * 为什么要打包而不是直接 import：见 psd-fonts-kit.ts 顶部。产物落在 .wrangler/
 * 下（已 gitignore），与本地运行时的 bundle 同一个去处。
 */
export async function loadKit({ outDir = join(ROOT, ".wrangler", "psd-fonts") } = {}) {
  const [{ build }, { resolveWorkspaceAliases }] = await Promise.all([
    import("esbuild"),
    import("./workspace-aliases.mjs"),
  ]);
  const outfile = join(outDir, "kit.mjs");
  await mkdir(outDir, { recursive: true });
  await build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "scripts", "psd-fonts-kit.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    alias: resolveWorkspaceAliases(ROOT),
    logOverride: { "empty-import-meta": "silent" },
  });
  return import(pathToFileURL(outfile).href);
}

export function parseArgs(argv) {
  const options = { configPath: undefined, credentialsPath: DEFAULT_CREDENTIALS_PATH };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--credentials") options.credentialsPath = required(argv, ++index, arg);
    else if (arg === "--psd-url") options.psdUrl = required(argv, ++index, arg);
    else if (arg === "--cas-origin") options.casOrigin = required(argv, ++index, arg);
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    else if (options.configPath === undefined) options.configPath = arg;
    else throw new Error(`多余的参数：${arg}`);
  }
  if (options.configPath === undefined) throw new Error("缺少配置文件路径");
  return options;
}

function required(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} 需要一个值`);
  return value;
}

const USAGE =
  "用法: node scripts/seed-psd-fonts.mjs <config.json> [--credentials <path>] [--psd-url <url>] [--cas-origin <url>]";

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(1);
  }
  const configPath = resolve(options.configPath);
  const credentialsPath = resolve(ROOT, options.credentialsPath);

  const config = parseSeedConfig(await readFile(configPath, "utf8"), { configPath });
  let credentialsText;
  try {
    credentialsText = await readFile(credentialsPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `端点/密钥文件不存在：${credentialsPath}。`
        + "本地开发跑一次 `pnpm dev`（Cloudflare 栈）就会生成它；"
        + "真实部署请照 scripts/seed-psd-fonts.mjs 顶部注释里的形状自己写一份。",
      );
    }
    throw error;
  }
  const parsed = parseCredentials(credentialsText, { credentialsPath });
  const credentials = Object.freeze({
    ...parsed,
    ...(options.psdUrl ? { psdUrl: trimSlash(options.psdUrl) } : {}),
    ...(options.casOrigin ? { casOrigin: trimSlash(options.casOrigin) } : {}),
  });

  console.log(`psd worker: ${credentials.psdUrl}`);
  console.log(`CAS:        ${credentials.casOrigin}  (stack ${credentials.stack.stackId})`);
  await seedFonts({ kit: await loadKit(), config, credentials });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
