/**
 * 穷尽性守卫：stack 模式下 Azure 入口点 `requireEnv` 的每一个变量，bicep
 * 模板都必须有对应的注入点。
 *
 * 挡的是真踩过的一类缺陷：`deploy.mjs` 强制 `--internal-auth-mode stack`，
 * 但 bicep 一个 `CAS_STACK_*` 都没注入 —— 编译、what-if 全绿，只在容器
 * 真起来时以 `Missing required environment variable` 崩溃。类型系统看不见
 * 这条边界，因为一头是 bicep 文本、另一头是 `process.env` 的字符串键。
 *
 * 只验"名字有没有接线点"，不验值：container-app.bicep 里几个密钥是
 * `empty(param) ? [] : [...]` 的条件注入，值对不对要靠 deploy.mjs 的必填
 * 校验（见 azure-deploy.test.mjs）和真部署时的冒烟。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEPLOY = join(ROOT, "stacks/unidocs-azure/deploy");

/** bicep 里环境变量名一律写成 `name: 'FOO'`（明文与 secretRef 都是）。 */
function envNames(template) {
  const source = readFileSync(join(DEPLOY, template), "utf8");
  return new Set(
    [...source.matchAll(/name:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
  );
}

function union(...sets) {
  return new Set(sets.flatMap((s) => [...s]));
}

/** `packages/azure-gateway/src/main.ts` 在 internalAuthMode === "stack" 时要的。 */
const GATEWAY_STACK_ENV = [
  "DATABASE_URL",
  "DOC_SERVICES_JSON",
  "INTERNAL_AUTH_MODE",
  "CAPABILITY_ALGORITHM",
  "CAPABILITY_TTL_SECONDS",
  "CAPABILITY_MAX_LIFETIME_SECONDS",
  "CAPABILITY_CLOCK_SKEW_SECONDS",
  "CAPABILITY_ISSUER",
  "CAPABILITY_KEY_ID",
  "CAPABILITY_PRIVATE_KEY_PKCS8",
  "CAS_CAPABILITY_AUDIENCE",
  // 以下五个是 stack 模式独有的；缺任意一个网关都起不来。
  "CAS_STACK_ID",
  "CAS_STACK_ISSUER",
  "CAS_STACK_KEY_ID",
  "CAS_STACK_PRIVATE_KEY_PKCS8",
  // 缺它则上传上限失效 —— 网关的克隆探测会把整个 body 解析进内存(还 clone
  // 一份),大文件直接撑崩网关进程,请求根本到不了 doc service。
  "MAX_UPLOAD_BYTES",
];

/**
 * `packages/azure-sdk/src/doc-type-service.ts` + `doctype-server-common` 的
 * `resolveDocAuthConfig()` 在 stack 模式时要的。
 */
const SERVICE_STACK_ENV = [
  "DATABASE_URL",
  "INTERNAL_AUTH_MODE",
  "CAPABILITY_ALGORITHM",
  "CAPABILITY_TTL_SECONDS",
  "CAPABILITY_MAX_LIFETIME_SECONDS",
  "CAPABILITY_CLOCK_SKEW_SECONDS",
  "CAPABILITY_ISSUER",
  "CAPABILITY_TRUSTED_JWKS",
  "DOC_CAPABILITY_AUDIENCE",
  "CAS_CAPABILITY_AUDIENCE",
  // CAS_STACK_ID 不是 requireEnv，但缺了 client 会拼 legacy 路由，
  // 打到规范中间件上一律 404 —— 功能上同样是必需的。
  "CAS_STACK_ID",
  "CAS_STACK_ISSUER",
  "CAS_STACK_TRUSTED_JWKS",
];

describe("Azure stack 模式的环境变量接线是穷尽的", () => {
  test("gateway.bicep + container-app.bicep 覆盖网关要的全部变量", () => {
    const injected = union(envNames("gateway.bicep"), envNames("container-app.bicep"));
    const missing = GATEWAY_STACK_ENV.filter((name) => !injected.has(name));
    expect(missing).toEqual([]);
  });

  test("service.bicep + container-app.bicep 覆盖 doc service 要的全部变量", () => {
    const injected = union(envNames("service.bicep"), envNames("container-app.bicep"));
    const missing = SERVICE_STACK_ENV.filter((name) => !injected.has(name));
    expect(missing).toEqual([]);
  });

  test("MAX_UPLOAD_BYTES 注入 doc service：缺它上传上限就失效，大文件会撑崩容器", () => {
    expect(envNames("service.bicep").has("MAX_UPLOAD_BYTES")).toBe(true);
  });

  test("CAS_REF_DOMAIN 注入网关：缺它时 Root Refs 写入会被 CAS 拒", () => {
    // 委派给 doc DO 的能力票靠这个 claim 才能过 updateRootRefs 的
    // refDomain 注册检查（unicas server-cloudflare/src/auth.ts）。
    expect(envNames("gateway.bicep").has("CAS_REF_DOMAIN")).toBe(true);
  });
});
