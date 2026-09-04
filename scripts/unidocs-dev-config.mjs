import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function parseDevArgs(argv, env = process.env) {
  const options = {
    // 本地启动默认 local：远端 CAS 需要一份注册好的开发者栈凭据
    // (`.wrangler/unidocs/stack.json`)，新克隆的仓库没有它，`pnpm dev` 会
    // 直接失败。默认值应该是「不配任何东西也能起来」的那个。
    // 需要远端时显式 `--cas remote`，或设 UNIDOCS_CAS_MODE=remote。
    casMode: env.UNIDOCS_CAS_MODE ?? "local",
    // 字体预置默认开着（auto）：`setText` 没有字体索引就一个字形都取不到,
    // 而"要人先手工跑一遍预置脚本"等于让这个功能默认关着。off 留给离线开发、
    // CI、以及就是不想要这几 MB 的场景 —— 那时 setText 仍然在工具表里,只是
    // 索引是空的。环境变量与 --cas 同一套优先级:显式参数 > 环境变量 > 默认。
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
 * 把本次本地运行时的端点和签名密钥写到 `.wrangler/unidocs/local-credentials.json`。
 *
 * 存在的理由：`startLocalRuntime` 的两把密钥（gateway 的 doc 身份、栈的 CAS 身份）
 * 默认是**每次启动现生成**的，只活在那个进程的内存里。凡是要绕过 gateway 直连
 * worker 的本地工具（第一个是 scripts/seed-psd-fonts.mjs —— 字体登记端点和
 * root-refs 都不在 gateway 的路由表里）都签不出凭据，除非运行时把它们落到磁盘上。
 *
 * 落的是私钥，所以 0600，并且只落在 `.wrangler/` 下 —— 那个目录已经 gitignore，
 * 也已经躺着同类东西（`.wrangler/unidocs/stack.json` 就是一份栈私钥）。
 */
export async function writeLocalCredentials({ root, runtime, casOrigin }) {
  const path = resolve(root, ".wrangler", "unidocs", "local-credentials.json");
  const capability = runtime.capabilityFixture;
  const stack = runtime.stackFixture;
  const credentials = {
    ...(runtime.urls.psd ? { psdUrl: runtime.urls.psd } : {}),
    casOrigin: casOrigin ?? runtime.urls.edge,
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
