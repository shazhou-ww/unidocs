/**
 * 对已部署的公网网关跑设计 §10 第 5 条的验收断言。
 *
 * 文档 id 每次运行随机:设计 §10 第 6 条要求重跑部署之后冒烟仍然全绿,
 * 固定 id 会在第二次运行时撞 DocExists。
 *
 * 用法:
 *   node stacks/unidocs-azure/deploy/smoke.mjs --gateway https://unidocs-gateway.<region>.azurecontainerapps.io
 *   node stacks/unidocs-azure/deploy/smoke.mjs --gateway https://unidocs-gateway.<region>.azurecontainerapps.io --no-cas
 *   node stacks/unidocs-azure/deploy/smoke.mjs --gateway http://127.0.0.1:41787 --skip-cas
 *   node stacks/unidocs-azure/deploy/smoke.mjs --gateway https://unidocs-gateway.<region>.azurecontainerapps.io --only docx
 *
 * `--only <docType>`(`markdown`、`docx` 或 `psd`)把冒烟收窄到一个 doc type 的
 * 流程,不给时测全部。`stacks/unidocs-azure/deploy/deploy.mjs` 在 `--service docx` 之后
 * 传 `--only docx`,这样一次只部一个服务不会因为另一个 doc type(这次根本
 * 没被触碰)恰好挂掉而报红。
 *
 * 有两个独立的开关,语义不同,**不可互换**:
 *
 * `--no-cas` 的意思是「这次部署本来就没有配置 CAS,第 3 组不适用」——
 * `scripts/azure-deploy.mjs` 在 `--cas-base-url` 为空时,第 7 步会自动带上
 * 它(从自己的部署配置派生,不是从命令行透传)。它对任何 `--gateway`(本地
 * 或非本地)都允许,但**不是无条件信任**:发出任何真正的断言之前,先对
 * 对随机 tenant 的 CAS node 路径探测一次 —— 未配
 * CAS 的网关上 `isPublicCasRoute` 恒为 `false`,这条请求必然 404
 * (`unicas-packages/tenant-protocol/src/routes.ts`);任何其它状态码都说明这个网关其实
 * 配置了 CAS,`--no-cas` 用错了地方,脚本在跑任何断言之前就直接中止 ——
 * 这条探测让开关无法被用来伪造绿色,即使有人手工对着一个配了 CAS 的网关
 * 传 `--no-cas`。跑完后收尾文案是 `smoke passed (no-CAS deployment — ...)`,
 * 刻意与 `all smoke assertions passed` 不同,防止被 grep 误读成完整验收。
 *
 * `--skip-cas` 跳过第 3 组,但**不做上面那条探测,也不改变收尾文案的严格
 * 程度那么多**——它只用于对本地 Azure 栈验证本脚本自身的 wire 形状(本地
 * 栈默认没有 casBaseUrl,直接用 `--no-cas` 会因为探测通过而效果等价,
 * `--skip-cas` 的存在只是历史遗留 + 明确标注"非验收"用途)。真实部署的
 * 验收**不得**带这个开关对付一个配了 CAS 的网关:第 3 组正是跨云 CAS 接线
 * 的唯一证明。为了不让这条规矩只停留在注释里,`--gateway` 指向非本地主机
 * 时若同时带了 `--skip-cas`(且没有 `--no-cas`),脚本在发出任何请求之前
 * 就直接拒绝退出——不允许对一个 `https://` 真部署跑一次"假绿"的验收。
 *
 * `--skip-cas` 与 `--no-cas` 同时给出是参数错误,直接拒绝:两者语义冲突
 * (一个是"我选择跳过",一个是"这次部署没有"),同时出现说明调用者自己
 * 都没想清楚要表达哪种情况。
 *
 * wire 形状(路由带一个 `docs` 命名空间段,建文档路径以 `/` 结尾、id 走
 * `X-Doc-Id` 头、无 body):见 packages/doctype-server-common/src/gateway-handler.ts:44,61
 * 以及 tests/treespec/create-new-markdown、create-new-docx 下的 spec.yaml。
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeNodeDigest, encodeHeader, hashToHex } from "../../../unicas-packages/codec/dist/index.js";
import { readAzureDocTypes } from "../doc-types.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const RUN = randomBytes(4).toString("hex");
const USER = `smoke-${RUN}`;

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 可冒烟的 doc type 由各包的 azure.service.json 声明，与 deploy.mjs 的
 *  azureImages()/service.bicep 同一个来源。 */
const KNOWN_DOC_TYPES = Object.keys(readAzureDocTypes(REPO_ROOT));

export function parseArgs(argv) {
  const args = { gateway: "", skipCas: false, noCas: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--gateway":
        args.gateway = argv[++i];
        break;
      case "--skip-cas":
        args.skipCas = true;
        break;
      case "--no-cas":
        args.noCas = true;
        break;
      case "--only":
        args.only = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!args.gateway) {
    throw new Error("--gateway is required");
  }
  if (args.skipCas && args.noCas) {
    throw new Error(
      "--skip-cas and --no-cas are mutually exclusive: --skip-cas means \"I am choosing to skip group 3 " +
      "for self-checking this script locally\", --no-cas means \"this deployment genuinely has no CAS " +
      "configured\" — passing both means the caller hasn't decided which one applies.",
    );
  }
  if (args.only !== null && !KNOWN_DOC_TYPES.includes(args.only)) {
    throw new Error(`--only must be one of ${KNOWN_DOC_TYPES.join(", ")}, got ${JSON.stringify(args.only)}`);
  }
  return args;
}

/**
 * 纯函数,不发请求、不读 fs——`expectedDocTypes` 是"这一轮应该覆盖哪些
 * doc type"(来自表或 `--only`),`ranDocTypes` 是"main() 实际执行到的
 * <docType>Flow() 覆盖了哪些"(一个 `Set`)。返回差集:非空即"表里有、
 * 但 smoke.mjs 没有对应 flow"的 doc type 列表。单独抽出来是为了不用起
 * 真实网关或在磁盘上伪造 azure.service.json 就能单测这条完整性校验本身,
 * 见 tests/unit/scripts/azure-smoke.test.mjs。
 */
export function missingDocTypeFlows(expectedDocTypes, ranDocTypes) {
  return expectedDocTypes.filter((docType) => !ranDocTypes.has(docType));
}

// `new URL(...).hostname` keeps the brackets around an IPv6 literal
// (`new URL("http://[::1]:8787").hostname === "[::1]"`, not `"::1"`) —
// pre-existing bug caught while adding `assertSkipCasAllowed()`'s test:
// the bracket-less `"::1"` here never matched, so `--skip-cas` against
// `http://[::1]:PORT` was silently treated as non-local and rejected.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 只信任 `new URL(gateway).hostname`,不做字符串 `includes` 判断——
 * 后者会被 `https://evil.com/?x=127.0.0.1` 这类输入骗过。
 */
export function isLocalHost(gateway) {
  return LOCAL_HOSTNAMES.has(new URL(gateway).hostname);
}

/**
 * `--no-cas` 的核心保护:不信任调用者说的"这次部署没配 CAS",自己对着
 * 真实网关发一次请求确认。未配 CAS 时 `isPublicCasRoute` 恒为 `false`
 * (`unicas-packages/tenant-protocol/src/routes.ts`),即 tenant CAS node POST
 * 必然拿到 `{error:"Unknown CAS endpoint"}` 的 404 —— 这条路由本身不校验
 * hash 格式,占位符即可命中。任何其它状态码(包括这个网关把请求转发给了
 * 真实 CAS worker 之后对方返回的 4xx/5xx)都证明 CAS 其实配置了,直接中止,
 * 不让 `--no-cas` 变成绕开第 3 组的后门。
 */
export async function assertCasNotConfigured(gateway) {
  const probeUser = `smoke-no-cas-probe-${RUN}`;
  const res = await fetch(`${gateway}/tenants/${probeUser}/cas/nodes/${"0".repeat(64)}`, {
    method: "POST",
  });
  if (res.status !== 404) {
    throw new Error(
      `--no-cas was passed but the gateway at ${gateway} answered the CAS probe with HTTP ${res.status} ` +
      "(expected 404, which is what an unconfigured gateway always returns for tenant CAS routes — see " +
      "unicas-packages/tenant-protocol/src/routes.ts). This gateway appears to have CAS configured, so group 3 (docx " +
      "image path through Cloudflare CAS) must run. Re-run without --no-cas.",
    );
  }
}

async function createDoc(gateway, docType, docId) {
  return fetch(`${gateway}/tenants/${USER}/docs/${docType}/`, {
    method: "POST",
    headers: { "X-Doc-Id": docId },
  });
}

async function apply(gateway, docType, docId, baseVersion, description, operations) {
  const res = await fetch(`${gateway}/tenants/${USER}/docs/${docType}/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion, description, operations }),
  });
  const body = await res.json();
  return { res, body };
}

async function query(gateway, docType, docId, kind, payload) {
  const res = await fetch(`${gateway}/tenants/${USER}/docs/${docType}/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ? { kind, payload } : { kind }),
  });
  const body = await res.json();
  return { res, body };
}

async function exportDoc(gateway, docType, docId) {
  const res = await fetch(`${gateway}/tenants/${USER}/docs/${docType}/${docId}/export`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

async function markdownFlow(gateway) {
  console.log("\n[1/5] markdown full flow");
  const docId = `md-${RUN}`;

  const created = await createDoc(gateway, "markdown", docId);
  const createdBody = await created.json();
  check("create → success", createdBody.success === true, JSON.stringify(createdBody));

  const content = `# Smoke ${RUN}\n\nHello from azure-smoke.`;
  const { body: applyBody } = await apply(gateway, "markdown", docId, 1, "smoke: set content", [
    { kind: "setContent", payload: { content } },
  ]);
  check(
    "apply setContent → success && version === 2",
    applyBody.success === true && applyBody.version === 2,
    JSON.stringify(applyBody),
  );

  const { body: queryBody } = await query(gateway, "markdown", docId, "getContent");
  check(
    "query getContent → contains written content",
    queryBody.success === true && typeof queryBody.data === "string" && queryBody.data.includes(`Smoke ${RUN}`),
    JSON.stringify(queryBody),
  );

  const { res: exportRes, bytes: exportBytes } = await exportDoc(gateway, "markdown", docId);
  check(
    "export → HTTP 200 with non-empty body",
    exportRes.status === 200 && exportBytes.length > 0,
    `status=${exportRes.status} length=${exportBytes.length}`,
  );
}

async function docxTextFlow(gateway, docId) {
  console.log("\n[2/5] docx full flow");

  const created = await createDoc(gateway, "docx", docId);
  const createdBody = await created.json();
  check("create → success", createdBody.success === true, JSON.stringify(createdBody));

  const { body: applyBody } = await apply(gateway, "docx", docId, 1, "smoke: append paragraph", [
    { kind: "appendParagraph", payload: { text: "smoke" } },
  ]);
  check(
    "apply appendParagraph → version === 2",
    applyBody.success === true && applyBody.version === 2,
    JSON.stringify(applyBody),
  );

  const { body: queryBody } = await query(gateway, "docx", docId, "getText");
  check(
    "query getText → contains 'smoke'",
    queryBody.success === true && typeof queryBody.data === "string" && queryBody.data.includes("smoke"),
    JSON.stringify(queryBody),
  );

  const { res: exportRes, bytes: exportBytes } = await exportDoc(gateway, "docx", docId);
  check(
    "export → zip magic bytes and non-empty",
    exportBytes.length > 0 && exportBytes[0] === 0x50 && exportBytes[1] === 0x4b,
    `status=${exportRes.status} length=${exportBytes.length} first2=${exportBytes[0]},${exportBytes[1]}`,
  );
}

async function docxImageFlow(gateway, docId) {
  console.log("\n[3/5] docx image path through Cloudflare CAS");

  const imagePath = join(REPO_ROOT, "tests/treespec/create-new-docx/edit/image/tiny.png");
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  const header = encodeHeader(imageBytes.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], imageBytes);
  const hash = hashToHex(digest);

  const uploadRes = await fetch(`${gateway}/tenants/${USER}/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-CAS-Lease-Duration": "900000",
    },
    body: imageBytes,
  });
  const uploadBody = await uploadRes.json();
  check("CAS upload → ready === true", uploadBody.ready === true, JSON.stringify(uploadBody));

  const { body: applyBody } = await apply(gateway, "docx", docId, 2, "smoke: insert image", [
    { kind: "insertImage", payload: { hash, widthPx: 16, altText: "dot" } },
  ]);
  check(
    "apply insertImage → version === 3",
    applyBody.success === true && applyBody.version === 3,
    JSON.stringify(applyBody),
  );

  const { body: queryBody } = await query(gateway, "docx", docId, "getImages");
  check(
    "query getImages → one png image with altText 'dot'",
    queryBody.success === true &&
      Array.isArray(queryBody.data) &&
      queryBody.data.length === 1 &&
      queryBody.data[0].format === "png" &&
      queryBody.data[0].altText === "dot",
    JSON.stringify(queryBody),
  );

  const { res: exportRes, bytes: exportBytes } = await exportDoc(gateway, "docx", docId);
  check(
    "export after image insert → still a valid zip",
    exportBytes.length > 0 && exportBytes[0] === 0x50 && exportBytes[1] === 0x4b,
    `status=${exportRes.status} length=${exportBytes.length} first2=${exportBytes[0]},${exportBytes[1]}`,
  );
}

async function psdFlow(gateway, docId) {
  console.log("\n[4/5] psd full flow");

  const created = await createDoc(gateway, "psd", docId);
  const createdBody = await created.json();
  check("create → success", createdBody.success === true, JSON.stringify(createdBody));

  // A `group` layer needs no pixel data, so this exercises add_layer/getLayers/
  // export without pulling in the CAS-backed pixel path. Proving the
  // SBlob → CAS wiring (getPreview on a raster layer) is a separate,
  // planned integration test, not this deployment smoke flow — see this
  // plan's Task 6 brief.
  const layerId = `smoke-layer-${RUN}`;
  const layerName = `Smoke ${RUN}`;
  const { body: applyBody } = await apply(gateway, "psd", docId, 1, "smoke: add layer", [
    {
      kind: "add_layer",
      payload: {
        layer: { id: layerId, type: "group", name: layerName, bounds: [0, 0, 0, 0] },
        parentId: null,
      },
    },
  ]);
  check(
    "apply add_layer → version === 2",
    applyBody.success === true && applyBody.version === 2,
    JSON.stringify(applyBody),
  );

  const { body: queryBody } = await query(gateway, "psd", docId, "getLayers");
  check(
    "query getLayers → one group layer with the added id/name",
    queryBody.success === true &&
      Array.isArray(queryBody.data) &&
      queryBody.data.length === 1 &&
      queryBody.data[0].id === layerId &&
      queryBody.data[0].name === layerName,
    JSON.stringify(queryBody),
  );

  const { res: exportRes, bytes: exportBytes } = await exportDoc(gateway, "psd", docId);
  // PSD files always start with the 4-byte "8BPS" signature (0x38 0x42 0x50
  // 0x53) — same idea as docxTextFlow's/docxImageFlow's zip magic-byte check,
  // not just "non-empty", so a routing bug that returns some other non-empty
  // body (e.g. an error page) still fails this instead of passing by
  // accident.
  check(
    "export → PSD magic bytes (8BPS) and non-empty",
    exportBytes.length > 0 &&
      exportBytes[0] === 0x38 &&
      exportBytes[1] === 0x42 &&
      exportBytes[2] === 0x50 &&
      exportBytes[3] === 0x53,
    `status=${exportRes.status} length=${exportBytes.length} first4=${exportBytes[0]},${exportBytes[1]},${exportBytes[2]},${exportBytes[3]}`,
  );
}

async function conflictFlow(gateway, docId, expectedVersion) {
  console.log("\n[5/5] concurrent conflict");

  const { res, body } = await apply(gateway, "docx", docId, 1, "smoke: stale write", [
    { kind: "appendParagraph", payload: { text: "should conflict" } },
  ]);
  check("stale apply → HTTP 409", res.status === 409, `status=${res.status} body=${JSON.stringify(body)}`);
  check(
    `stale apply → body.version === ${expectedVersion}`,
    body.version === expectedVersion,
    JSON.stringify(body),
  );
}

/**
 * 拆成纯函数(不发请求、只看 `args` + 已经算好的 `gateway`)是为了能单测
 * "非本地 + --skip-cas 且没有 --no-cas -> 拒绝" 这条规则,不需要真的起一个
 * 网关。`--no-cas` 走的是另一条不同的保护(`assertCasNotConfigured()`,
 * 真的发请求探测),这里只负责 `--skip-cas` 那一半。
 */
export function assertSkipCasAllowed(args, gateway) {
  if (args.skipCas && !args.noCas && !isLocalHost(gateway)) {
    throw new Error(
      `--skip-cas was passed with a non-local --gateway (${gateway}). ` +
        "--skip-cas only exists for self-checking this script against the local Azure stack, " +
        "which has no casBaseUrl by default. A real deployment's acceptance run must not skip " +
        "group 3 (docx image path through Cloudflare CAS) — that group is the only proof the " +
        "cross-cloud CAS wiring actually works. Re-run without --skip-cas, or use --no-cas if this " +
        "deployment genuinely has no CAS configured (it will be verified, not just trusted).",
    );
  }
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = args.gateway.replace(/\/+$/, "");

  assertSkipCasAllowed(args, gateway);

  if (args.noCas) {
    await assertCasNotConfigured(gateway);
  }

  console.log(
    `azure-smoke: gateway=${gateway} run=${RUN} skipCas=${args.skipCas} noCas=${args.noCas} only=${args.only ?? "all"}`,
  );

  // `--only <docType>` narrows the run to one doc type's flow — used by
  // `stacks/unidocs-azure/deploy/deploy.mjs` after `--service docx` so a stale/unrelated
  // markdown deployment can't fail a docx-only smoke run. Not given (or
  // given the other doc type) skips the corresponding flow entirely.
  //
  // `ranFlows` records which doc type(s) *actually* ran a flow below — not
  // which ones KNOWN_DOC_TYPES says exist. KNOWN_DOC_TYPES is now derived
  // from the azure.service.json table (readAzureDocTypes()) and grows on its
  // own; the three `if` blocks below are still one hand-written branch per doc
  // type, because each flow exercises genuinely different operations
  // (markdown's setContent/getContent, docx's appendParagraph/insertImage/
  // CAS upload, psd's add_layer/getLayers) and there is no generic "run the
  // flow for this doc type" table to dispatch through. Decoupling the
  // validation table from the dispatch means a new table entry with no
  // matching branch here would silently match no `if`, run zero assertions,
  // and still print "all smoke assertions passed" — see the completeness
  // check after this block, which turns that silent gap into a loud failure
  // instead of re-hardcoding the same doc type list a second time.
  const ranFlows = new Set();

  if (!args.only || args.only === "markdown") {
    await markdownFlow(gateway);
    ranFlows.add("markdown");
  }

  if (!args.only || args.only === "docx") {
    const docxDocId = `docx-${RUN}`;
    await docxTextFlow(gateway, docxDocId);

    let docxVersionAfterGroup2Or3 = 2;
    if (args.skipCas) {
      console.log("\n[3/5] docx image path through Cloudflare CAS — SKIPPED (--skip-cas)");
    } else if (args.noCas) {
      console.log("\n[3/5] docx image path through Cloudflare CAS — CAS not configured, group 3 not applicable (--no-cas, verified)");
    } else {
      await docxImageFlow(gateway, docxDocId);
      docxVersionAfterGroup2Or3 = 3;
    }

    await conflictFlow(gateway, docxDocId, docxVersionAfterGroup2Or3);
    ranFlows.add("docx");
  }

  if (!args.only || args.only === "psd") {
    const psdDocId = `psd-${RUN}`;
    await psdFlow(gateway, psdDocId);
    ranFlows.add("psd");
  }

  // Completeness gate: compare "doc types this run was supposed to cover"
  // (derived from the table, or the single `--only` target) against "doc
  // types that actually ran a flow above" (derived from real execution, not
  // from re-checking membership in KNOWN_DOC_TYPES). A gap here means a doc
  // type is declared in some packages/azure-<name>/azure.service.json but
  // smoke.mjs has no matching <docType>Flow wired into the dispatch above —
  // exactly the case introduced when KNOWN_DOC_TYPES stopped being the same
  // hand-written list as the `if` branches. Failing loudly here is the whole
  // point: without it, a new doc type would make every smoke run silently
  // skip its checks and still report success. `missingDocTypeFlows()` is a
  // pure function (no fetch, no fs) precisely so this comparison itself is
  // unit-testable without a real gateway or a fake azure.service.json on
  // disk — see tests/unit/scripts/azure-smoke.test.mjs.
  const expectedFlows = args.only ? [args.only] : KNOWN_DOC_TYPES;
  const missing = missingDocTypeFlows(expectedFlows, ranFlows);
  if (missing.length > 0) {
    throw new Error(
      `smoke.mjs has no flow wired up for doc type(s): ${missing.join(", ")}. ` +
      "They are declared via packages/azure-<name>/azure.service.json " +
      "(stacks/unidocs-azure/doc-types.mjs's readAzureDocTypes(), which is where KNOWN_DOC_TYPES above " +
      "comes from), but main() only dispatches to markdownFlow()/docxTextFlow() by name — there is " +
      "no generic per-doc-type flow to fall back to. Add a <docType>Flow() for it and wire it into " +
      "the `if` blocks above before deploying or smoke-testing this doc type; otherwise this would " +
      "silently run zero assertions for it and still print \"all smoke assertions passed\".",
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  if (args.skipCas) {
    // Deliberately not "all smoke assertions passed" — a grep for that exact
    // phrase (or a bare exit-code check) must not read this as a full
    // deployment acceptance pass when group 3 never ran.
    console.log("\nsmoke passed (CAS group SKIPPED — not a deployment acceptance run)");
  } else if (args.noCas) {
    // Also deliberately distinct from "all smoke assertions passed" — see
    // above. This one additionally differs from the --skip-cas message so
    // the two "group 3 didn't run" reasons (chose to skip vs. genuinely not
    // configured, and verified as such) don't collapse into the same text.
    console.log("\nsmoke passed (no-CAS deployment — cross-cloud CAS group not applicable)");
  } else {
    console.log("\nall smoke assertions passed");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}
