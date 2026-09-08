/**
 * 让 `pnpm dev` 起来就带着一套**全量**字体：**有就跳过，没有就灌**。
 *
 * ## 它现在是"锦上添花"，不再是"功能的前提"
 *
 * 内置字体（@unidocs/fonts-builtin）随包走，`setText` 不跑这一步也能工作。这个
 * 脚本现在解决的是另外两件事：
 *   1. 本地素材 PSD 点名的 JosefinSans-Bold —— 灌上它那些层才是按原字形重排；
 *   2. 全量 NotoSansSC 比内置子集多两万多个码位（港台字形、扩展区、生僻字）。
 * 所以它失败仍然不阻断启动，而且现在连"功能默认是关着的"这个后果都没有了。
 *
 * 第 2 件事靠的是**同名覆盖**：它灌进去的两套用的是和内置那两套一样的
 * `postScriptName`，而 `createFontRegistry` 的 providers 顺序是"内置在前、租户
 * 在后、后者按 postScriptName 覆盖前者"。所以不需要动回退链配置 —— 同一条
 * `BUILTIN_FALLBACKS` 在灌过之后解析到的就是全量版。
 *
 * ## 三条设计上的裁定
 *
 * 1. **幂等判据是"索引里有没有"，不是标记文件。** 标记文件会和真实状态漂移
 *    —— 索引被清掉（换租户、删 `.wrangler/`）而标记还在，就永远补不回来了。
 *    所以每次启动先 GET 一次索引，缺哪套灌哪套。
 *
 * 2. **一律不阻断启动。** 没网、下载失败、预置失败，全部收敛成一条醒目的警告
 *    然后继续。开发环境因为字体下不下来就起不来，是不可接受的。本模块的
 *    `ensurePsdFonts` 因此**从不抛**。
 *
 * 3. **下载来的文件要过校验才算数。** 半个文件比没有文件更难查：它存在、大小
 *    看着也对，只在真去排字时炸。校验直接复用 `describeFont` —— 体积闸、
 *    解析、`postScriptName` 对得上、cmap 非空，与手工预置同一套判据。落盘先写
 *    `.part` 再改名，中断留下的是一个显然的半成品，不是一个假装完好的字体。
 *
 * ## 与栈无关
 *
 * 本模块**不知道自己在给哪个栈灌字体**，也不该知道：端点从 `credentials.psdUrl`
 * 来，那份凭据由 `writeLocalCredentials` 按本次运行时的真实地址写出来。所以这里
 * 没有、也不要有按 `UNIDOCS_LOCAL_PLATFORM` 分支的端口表 —— 端口的事实来源是
 * `stacks/unidocs-cloudflare/local/doc-types.mjs` 与 `packages/azure-psd/azure.service.json`，
 * 在这里抄一份就是第二个来源，改了那边这边不会报错，只会灌到一个没人在听的地址上。
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  createDocTokenFactory,
  describeFont,
  fontsUrlFor,
  loadKit,
  parseCredentials,
  readFontIndex,
  seedFonts,
} from "./seed-psd-fonts.mjs";

/**
 * 默认灌进哪个租户。
 *
 * `u1` 不是随便挑的：本地 psd 前端把它硬编码成 `USER`
 * （`packages/web-psd/src/doc-controller.ts`），两个栈的本地 gateway 又都开着
 * `INSECURE_PATH_IDENTITY`，所以浏览器里点开的每一篇 psd 文档都落在这个租户下。
 * 灌进别的租户 = 灌了个寂寞。两处对不上会静默失效（索引查不到就是空索引），
 * 所以有一条测试盯着这两个常量相等。
 *
 * 需要别的租户（比如走 OAuth 登录后拿到的真实租户）就设 `UNIDOCS_PSD_FONT_TENANT`。
 */
export const DEFAULT_FONT_TENANT = "u1";

/**
 * 要装哪几套、从哪儿下。
 *
 * 中英各一套，与内置那两档一一对应 —— 这份计划的作用是**同名顶替**，少哪一套
 * 就是那一档留在内置的版本上（拉丁那档其实同为全量，中文那档会停在 8105 字的
 * 子集）。拉丁那套和内置那份眼下是**同一份字节**（同一个哈希），真正多出东西的
 * 只有中文那套。少了不会报错，也不会**整层**画不出来（内置那档兜着），只是少了
 * 多出来的那些码位。
 *
 * 中文那套点名到 `Sans/SubsetOTF/SC`：noto-cjk 里好几个都叫得上 "Noto Sans SC"，
 * 而 `Sans/OTC/NotoSansCJK-Regular.ttc`（18.6 MB）过不了脚本 16 MiB 那道闸。
 * 各版本实测体积见 docs/psd-text-layers.md §5.4。
 *
 * 都是 OFL，允许分发。**全量**字节不进仓库（裁定 R19 于 2026-09-08 收窄为"只许
 * 提交有明确公开字表依据的子集，单文件不超过约 3 MB"，随包发行的那两套子集见
 * `packages/fonts-builtin`），下到仓库根的 `fonts/` —— 那个目录已经 gitignore。
 *
 * `fallback: false` 的条目灌进索引但不进回退链，见 `psdFontFallbacks`。
 *
 * `postScriptName` 在这里是**待核对的声明**，不是可以随手写的标签：前两条必须
 * 和 `@unidocs/fonts-builtin` 内置那两套**逐字一致**，同名才会覆盖，全量版才
 * 顶掉内置子集；写岔一个字母就变成"索引里多了两条谁也选不中的条目"，而回退链
 * 仍然解析到内置子集，不报错。核对由 `describeFont` 做 —— 解析出来的名字和这里
 * 对不上就当场拒绝，于是"把 NotoSans-Regular 写成家族名 NotoSans"这种错只会
 * 响亮地失败。
 */
export const PSD_FONT_PLAN = Object.freeze([
  Object.freeze({
    postScriptName: "NotoSans-Regular",
    file: "fonts/NotoSans-Regular.ttf",
    url: "https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf",
  }),
  Object.freeze({
    postScriptName: "NotoSansSC-Regular",
    file: "fonts/NotoSansSC-Regular.otf",
    url: "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf",
  }),
  // 素材字体,不是兜底字体 —— 所以 `fallback: false`。它是本地那两份 PSD
  // (landing-page / fashion-banner)真正点名的字体,灌上之后那些层是按原字形
  // 重排,而不是"能排出来但换了个字体"。574 个码位、纯拉丁,当兜底会让任何
  // 缺字体的中文层全军覆没,所以它绝不该进回退链。
  //
  // OFL,允许分发(仓库根 OFL.txt:"licensed under the SIL Open Font License")。
  Object.freeze({
    postScriptName: "JosefinSans-Bold",
    file: "fonts/JosefinSans-Bold.ttf",
    url: "https://github.com/googlefonts/josefinsans/raw/master/fonts/ttf/JosefinSans-Bold.ttf",
    fallback: false,
  }),
]);

/**
 * 这份计划里**当兜底**的那些名字：逗号分隔、顺序即优先级。
 *
 * 拉丁在前、中文在后 —— 前者不覆盖 CJK，汉字自然落到后者。
 *
 * **它已经不是 `PSD_FONT_FALLBACKS` 的默认值了**：那个默认值住在
 * `@unidocs/fonts-builtin` 的 `BUILTIN_FALLBACKS` 里，由
 * `parseFontFallbacks(env.PSD_FONT_FALLBACKS, BUILTIN_FALLBACKS)` 接线，
 * `scripts/dev.mjs` 不再往两个栈里传这个值。这里灌的两套用的是**同名**
 * `postScriptName`，租户那一档按名字盖掉内置那一档，所以那条默认回退链在灌过
 * 之后自动指向全量版 —— 不需要也不该再配一遍。
 *
 * 留着它是因为"这套字体这里有"和"缺字体时拿它顶"仍然是两件事（`fallback: false`
 * 的 JosefinSans-Bold 就只满足前者），而 `.dev.vars.example` 里那行给操作者抄的
 * 示例值必须和这份判断一致 —— 有一条测试盯着这两处相等。
 */
export function psdFontFallbacks(plan = PSD_FONT_PLAN) {
  // `fallback: false` 的条目照常灌进索引,但不进回退链:"这套字体这里有" 和
  // "缺字体时拿它顶" 是两件事。缺省视为兜底 —— 不写这个字段的计划(测试里的
  // 自制计划、以后新增的条目)行为不变。
  return plan.filter(font => font.fallback !== false).map(font => font.postScriptName).join(",");
}

/** 把计划里的相对路径解释成相对仓库根 —— 相对进程 CWD 会随启动目录漂。 */
function resolvePlan(root, plan) {
  return plan.map(font => Object.freeze({ ...font, file: resolve(root, font.file) }));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 下一套字体到本地。
 *
 * 先写 `.part` 再校验再改名：中断或半截响应留下的是一个显然的半成品，而不是
 * 一个大小不对却看着完好的字体文件。校验读的是**磁盘上那份**而不是内存里的
 * buffer —— 要证明的正是"落到盘上的这个文件能用"。
 */
export async function downloadFont(font, { kit, fetchImpl = fetch, log = console.log } = {}) {
  const part = `${font.file}.part`;
  await mkdir(dirname(font.file), { recursive: true });
  let response;
  try {
    // GitHub 的 /raw/ 会 302 到 raw.githubusercontent.com；fetch 默认跟随重定向。
    response = await fetchImpl(font.url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`下载 ${font.postScriptName} 失败（${font.url}）：${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`下载 ${font.postScriptName} 失败 ${response.status}（${font.url}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(part, bytes);
  try {
    await describeFont(kit, { ...font, family: font.postScriptName, file: part });
  } catch (error) {
    await rm(part, { force: true });
    throw new Error(`下载来的 ${font.url} 没通过校验：${error.message}`);
  }
  await rename(part, font.file);
  log(`downloaded ${font.postScriptName}  ${bytes.length} bytes  -> ${font.file}`);
}

/**
 * 启动时的自动预置。**从不抛** —— 任何失败都变成一条 `warn` 然后返回。
 *
 * 返回 `{ status, ... }`：`ready`（索引已齐，什么都没做）、`seeded`（灌了）、
 * `failed`（失败，已经警告过了）。调用方不需要据此做任何事，返回值是给测试和
 * 日志用的。
 */
export async function ensurePsdFonts({
  root,
  credentialsPath,
  credentials: providedCredentials,
  tenantId = DEFAULT_FONT_TENANT,
  plan = PSD_FONT_PLAN,
  kit: providedKit,
  fetchImpl = fetch,
  // 两个注入点,都只为测试:单测要能断言"跳过时一次下载都没发"和"只灌缺的
  // 那套",而真正的下载与真正的 CAS 写入分别由 downloadFont 自己的单测和
  // tests/integration/cloudflare/psd-fonts-e2e.test.mjs 对着真 workerd 守着。
  download = downloadFont,
  seed = seedFonts,
  log = console.log,
  warn = console.warn,
} = {}) {
  try {
    const fonts = resolvePlan(root, plan);
    const credentials = providedCredentials
      ?? parseCredentials(await readFile(credentialsPath, "utf8"), { credentialsPath });
    // kit 要 esbuild 打一次包（见 seed-psd-fonts.mjs 的 loadKit）。跳过那条路
    // 也得先有它 —— 读索引要签一张凭据，签发器只存在于 TypeScript 源码里。
    const kit = providedKit ?? await loadKit();

    const fontsUrl = fontsUrlFor(credentials, tenantId);
    const docToken = await createDocTokenFactory(kit, credentials, tenantId);
    const index = await readFontIndex({ fontsUrl, docToken, fetchImpl });
    const present = new Set(index.map(entry => entry.postScriptName));
    const missing = fonts.filter(font => !present.has(font.postScriptName));
    if (missing.length === 0) {
      log(`PSD 字体索引已就绪（${fonts.map(f => f.postScriptName).join(", ")}），跳过预置。`);
      return { status: "ready", registered: [] };
    }

    // 缺文件的才下。两套并行：中文那套 8 MB，串起来会让首次启动明显更久。
    const toDownload = [];
    for (const font of missing) {
      if (!await exists(font.file)) toDownload.push(font);
    }
    if (toDownload.length > 0) {
      log(`PSD 字体：缺 ${toDownload.map(f => f.postScriptName).join(", ")}，正在下载（中文那套约 8 MB）…`);
      await Promise.all(toDownload.map(font => download(font, { kit, fetchImpl, log })));
    }

    log(`PSD 字体：正在预置 ${missing.map(f => f.postScriptName).join(", ")} 到租户 ${tenantId}…`);
    await seed({
      kit,
      config: {
        tenantId,
        fonts: missing.map(font => ({
          postScriptName: font.postScriptName,
          family: font.postScriptName,
          file: font.file,
        })),
      },
      credentials,
      log,
      fetchImpl,
    });
    return { status: "seeded", registered: missing.map(font => font.postScriptName) };
  } catch (error) {
    warn(fontWarning(error, { tenantId, root, credentialsPath }));
    return { status: "failed", error: error.message };
  }
}

/**
 * 失败时打的那条警告。要说清三件事，缺一件就等于让人自己猜：**这次少了什么
 * 功能**、**怎么手工补**、**怎么彻底关掉**。
 *
 * 手工那条命令必须带上 `--credentials`：两个栈各写各的一份凭据（见
 * `LOCAL_CREDENTIALS_PATHS`），照默认路径跑会拿 Cloudflare 那份去灌 —— 而那
 * 不会报错，只会灌进另一个栈的字体表，本栈的索引照样是空的。
 */
function fontWarning(error, { tenantId, root, credentialsPath }) {
  const credentialsFlag = credentialsPath
    ? ` --credentials ${root ? relative(root, credentialsPath) : credentialsPath}`
    : "";
  return [
    "",
    `⚠️  PSD 字体自动预置没成功：${error.message}`,
    "    setText（改文字层的文字）照常可用 —— 内置字体随包走，拉丁全量 + 中文 8105 字。",
    "    本次启动少的是这两样：素材 PSD 点名的 JosefinSans-Bold（那些层会换个字形重排），",
    "    以及全量 NotoSansSC 多出来的那两万多个码位（港台字形、扩展区、生僻字会缺字形）。",
    "    联网后重跑 `pnpm dev` 会自动重试；也可以手工灌：",
    `      1) 把字体放进 fonts/（见 docs/psd-text-layers.md §5.4 的下载地址）`,
    `      2) 照 scripts/psd-fonts.example.json 写一份配置（tenantId 填 ${tenantId}）`,
    `      3) node scripts/seed-psd-fonts.mjs <你的配置>.json${credentialsFlag}`,
    "    不想要字体：`pnpm dev … --fonts off`，或设 UNIDOCS_PSD_FONTS=off。",
    "",
  ].join("\n");
}
