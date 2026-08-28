import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function parseDevArgs(argv, env = process.env) {
  const options = {
    // 本地启动默认 local：远端 CAS 需要一份注册好的开发者栈凭据
    // (`.wrangler/unidocs/stack.json`)，新克隆的仓库没有它，`pnpm dev` 会
    // 直接失败。默认值应该是「不配任何东西也能起来」的那个。
    // 需要远端时显式 `--cas remote`，或设 UNIDOCS_CAS_MODE=remote。
    casMode: env.UNIDOCS_CAS_MODE ?? "local",
    docTypes: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--cas") options.casMode = argv[++index];
    else options.docTypes.push(arg);
  }
  if (options.casMode !== "remote" && options.casMode !== "local") {
    throw new Error("--cas must be remote or local");
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