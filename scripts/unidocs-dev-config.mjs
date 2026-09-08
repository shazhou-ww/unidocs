import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function parseDevArgs(argv, env = process.env) {
  const options = {
    // 本地启动默认 local：远端 CAS 需要一份注册好的开发者栈凭据
    // (`.wrangler/unidocs/stack.json`)，新克隆的仓库没有它，`pnpm dev` 会
    // 直接失败。默认值应该是「不配任何东西也能起来」的那个。
    // 需要远端时显式 `--cas remote`，或设 UNIDOCS_CAS_MODE=remote。
    casMode: env.UNIDOCS_CAS_MODE ?? "local",
    // 字体预置默认开着（auto）。**理由已经不是"不预置就排不出字"** —— 内置那
    // 两套（`@unidocs/fonts-builtin`，拉丁全量 + 中文 8105 字子集）随包走，
    // `--fonts off` 之后合成索引仍然是那两条、不是空的，中英混排照样排得出来
    // （`tests/integration/cloudflare/psd-fonts-e2e.test.mjs` 的「零配置」那条
    // 守着这件事）。默认开着是因为它多装的东西本地确实要用：全量 NotoSansSC
    // 比内置子集多两万多个码位,而两份示例 PSD 点名的 JosefinSans-Bold 只有灌了
    // 才是按原字形重排。off 留给离线开发、CI、以及就是不想要这几 MB 的场景 ——
    // 代价只是少掉这些,不是 setText 失灵。
    // 环境变量与 --cas 同一套优先级:显式参数 > 环境变量 > 默认。
    fontsMode: env.UNIDOCS_PSD_FONTS ?? "auto",
    docTypes: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--cas") options.casMode = argv[++index];
    else if (arg === "--fonts") options.fontsMode = argv[++index];
    else options.docTypes.push(arg);
  }
  if (options.casMode !== "remote" && options.casMode !== "local") {
    throw new Error("--cas must be remote or local");
  }
  if (options.fontsMode !== "auto" && options.fontsMode !== "off") {
    throw new Error("--fonts must be auto or off");
  }
  return options;
}

export async function loadRemoteCasConfig({ root, env = process.env }) {
  const origin = normalizeOrigin(env.UNIDOCS_CAS_ORIGIN ?? "https://unicas.shazhou.work");
  const credentialFile = resolve(
    root,
    env.UNIDOCS_CAS_STACK_CREDENTIAL ?? ".wrangler/unidocs/stack.json",
  );
  let fixture;
  try {
    fixture = JSON.parse(await readFile(credentialFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Remote UniCAS credential not found: ${credentialFile}. Register a developer stack or use --cas local.`,
      );
    }
    throw new Error(`Cannot read remote UniCAS credential ${credentialFile}: ${error.message}`);
  }
  for (const field of ["stackId", "issuer", "audience", "kid", "privateKeyPkcs8", "jwks"]) {
    if (!fixture[field]) throw new Error(`Remote UniCAS credential is missing ${field}: ${credentialFile}`);
  }
  if (!Array.isArray(fixture.jwks.keys) || fixture.jwks.keys.length === 0) {
    throw new Error(`Remote UniCAS credential has no JWKS keys: ${credentialFile}`);
  }
  return { origin, credentialFile, stackFixture: fixture };
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("UNIDOCS_CAS_ORIGIN must be an origin without a path, query, or fragment");
  }
  return url.origin;
}

/**
 * 每个栈把自己那份凭据写在**自己的** scratch 目录里，两个目录都已 gitignore。
 *
 * 为什么不是一个文件：两套栈可以同时跑（见 scripts/dev.mjs 顶部
 * `AZURE_WEB_PORT_OFFSET` 的注释），共用一个路径就是后起的那个把先起的那个
 * 覆盖掉。而覆盖之后手工跑 `seed-psd-fonts.mjs` 的失败形态是**静默的**：
 * 凭据签得出来、请求也成功，只是灌进了另一个栈的字体表，本栈的登记表仍然是空的
 * （说"索引"会读岔：本计划之后"索引"指的是合成索引，而它有内置那一档兜着、永不为空）。
 */
export const LOCAL_CREDENTIALS_PATHS = Object.freeze({
  cloudflare: Object.freeze([".wrangler", "unidocs", "local-credentials.json"]),
  azure: Object.freeze([".azure-runtime", "local-credentials.json"]),
});

export function localCredentialsPath(root, platform) {
  const parts = LOCAL_CREDENTIALS_PATHS[platform];
  if (!parts) {
    throw new Error(
      `writeLocalCredentials(): unknown platform ${JSON.stringify(platform)}; `
      + `known: ${Object.keys(LOCAL_CREDENTIALS_PATHS).join(", ")}`,
    );
  }
  return resolve(root, ...parts);
}

/**
 * 把本次本地运行时的端点和签名密钥写到该栈的 `local-credentials.json`。
 *
 * 存在的理由：本地运行时的两把密钥（gateway 的 doc 身份、栈的 CAS 身份）默认是
 * **每次启动现生成**的，只活在那个进程的内存里。凡是要绕过 gateway 直连
 * doc service 的本地工具（第一个是 scripts/seed-psd-fonts.mjs —— 字体登记端点和
 * root-refs 都不在 gateway 的路由表里）都签不出凭据，除非运行时把它们落到磁盘上。
 *
 * 两个栈都写：`/tenants/{t}/fonts` 已经下沉成中立路由，同一个脚本指向哪个
 * service 就灌哪个，所以「能签出凭据」这件事不能只有 Cloudflare 那一路有。
 *
 * 落的是私钥，所以 0600，并且只落在已 gitignore 的目录下（`.wrangler/unidocs/`
 * 里本来就躺着同类东西：`stack.json` 就是一份栈私钥）。
 */
export async function writeLocalCredentials({ root, runtime, casOrigin, platform }) {
  const path = localCredentialsPath(root, platform);
  const capability = runtime.capabilityFixture;
  const stack = runtime.stackFixture;
  const credentials = {
    ...(runtime.urls.psd ? { psdUrl: runtime.urls.psd } : {}),
    // 两个运行时挂 UniCAS 的位置不同：Cloudflare 那一路的 edge 就在 `urls` 里，
    // Azure 那一路是一个嵌入的中间件运行时（`runtime.middleware.urls.edge`）。
    // `--cas remote` 时两边都由调用方显式传远端 origin。
    casOrigin: casOrigin ?? runtime.middleware?.urls?.edge ?? runtime.urls.edge,
    docAudience: "unidocs-doc:psd",
    doc: {
      issuer: capability.issuer,
      kid: capability.kid,
      privateKeyPkcs8: capability.privateKeyPkcs8,
    },
    stack: {
      stackId: stack.stackId,
      issuer: stack.issuer,
      audience: stack.audience,
      kid: stack.kid,
      privateKeyPkcs8: stack.privateKeyPkcs8,
      refDomain: "doc",
    },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}
