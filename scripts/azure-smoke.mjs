#!/usr/bin/env node
/**
 * 对已部署的公网网关跑设计 §10 第 5 条的验收断言。
 *
 * 文档 id 每次运行随机:设计 §10 第 6 条要求重跑部署之后冒烟仍然全绿,
 * 固定 id 会在第二次运行时撞 DocExists。
 *
 * 用法:
 *   node scripts/azure-smoke.mjs --gateway https://ca-unidocs-gateway.<region>.azurecontainerapps.io
 *   node scripts/azure-smoke.mjs --gateway http://127.0.0.1:41787 --skip-cas
 *
 * `--skip-cas` 跳过第 3 组(docx 图片路径)。它只用于对本地 Azure 栈
 * 验证本脚本自身的 wire 形状 —— 本地栈默认没有 casBaseUrl。真实部署的
 * 验收**不得**带这个开关:第 3 组正是跨云 CAS 接线的唯一证明。为了不让
 * 这条规矩只停留在注释里,`--gateway` 指向非本地主机时若同时带了
 * `--skip-cas`,脚本在发出任何请求之前就直接拒绝退出——不允许对一个
 * `https://` 真部署跑一次"假绿"的验收。
 *
 * wire 形状(路由带一个 `docs` 命名空间段,建文档路径以 `/` 结尾、id 走
 * `X-Doc-Id` 头、无 body):见 packages/server-core/src/gateway-handler.ts:44,61
 * 以及 tests/treespec/create-new-markdown、create-new-docx 下的 spec.yaml。
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeNodeDigest, encodeHeader, hashToHex } from "../packages/cas-server-common/dist/index.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
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

function parseArgs(argv) {
  const args = { gateway: "", skipCas: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--gateway":
        args.gateway = argv[++i];
        break;
      case "--skip-cas":
        args.skipCas = true;
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!args.gateway) {
    throw new Error("--gateway is required");
  }
  return args;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * 只信任 `new URL(gateway).hostname`,不做字符串 `includes` 判断——
 * 后者会被 `https://evil.com/?x=127.0.0.1` 这类输入骗过。
 */
function isLocalHost(gateway) {
  return LOCAL_HOSTNAMES.has(new URL(gateway).hostname);
}

async function createDoc(gateway, docType, docId) {
  return fetch(`${gateway}/users/${USER}/docs/${docType}/`, {
    method: "POST",
    headers: { "X-Doc-Id": docId },
  });
}

async function apply(gateway, docType, docId, baseVersion, description, operations) {
  const res = await fetch(`${gateway}/users/${USER}/docs/${docType}/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion, description, operations }),
  });
  const body = await res.json();
  return { res, body };
}

async function query(gateway, docType, docId, kind, payload) {
  const res = await fetch(`${gateway}/users/${USER}/docs/${docType}/${docId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ? { kind, payload } : { kind }),
  });
  const body = await res.json();
  return { res, body };
}

async function exportDoc(gateway, docType, docId) {
  const res = await fetch(`${gateway}/users/${USER}/docs/${docType}/${docId}/export`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

async function markdownFlow(gateway) {
  console.log("\n[1/4] markdown full flow");
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
  console.log("\n[2/4] docx full flow");

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
  console.log("\n[3/4] docx image path through Cloudflare CAS");

  const imagePath = join(REPO_ROOT, "tests/treespec/create-new-docx/edit/image/tiny.png");
  const imageBytes = new Uint8Array(readFileSync(imagePath));
  const header = encodeHeader(imageBytes.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], imageBytes);
  const hash = hashToHex(digest);

  const uploadRes = await fetch(`${gateway}/users/${USER}/cas/nodes/${hash}`, {
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

async function conflictFlow(gateway, docId, expectedVersion) {
  console.log("\n[4/4] concurrent conflict");

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = args.gateway.replace(/\/+$/, "");

  if (args.skipCas && !isLocalHost(gateway)) {
    throw new Error(
      `--skip-cas was passed with a non-local --gateway (${gateway}). ` +
        "--skip-cas only exists for self-checking this script against the local Azure stack, " +
        "which has no casBaseUrl by default. A real deployment's acceptance run must not skip " +
        "group 3 (docx image path through Cloudflare CAS) — that group is the only proof the " +
        "cross-cloud CAS wiring actually works. Re-run without --skip-cas.",
    );
  }

  console.log(`azure-smoke: gateway=${gateway} run=${RUN} skipCas=${args.skipCas}`);

  await markdownFlow(gateway);

  const docxDocId = `docx-${RUN}`;
  await docxTextFlow(gateway, docxDocId);

  let docxVersionAfterGroup2Or3 = 2;
  if (args.skipCas) {
    console.log("\n[3/4] docx image path through Cloudflare CAS — SKIPPED (--skip-cas)");
  } else {
    await docxImageFlow(gateway, docxDocId);
    docxVersionAfterGroup2Or3 = 3;
  }

  await conflictFlow(gateway, docxDocId, docxVersionAfterGroup2Or3);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  if (args.skipCas) {
    // Deliberately not "all smoke assertions passed" — a grep for that exact
    // phrase (or a bare exit-code check) must not read this as a full
    // deployment acceptance pass when group 3 never ran.
    console.log("\nsmoke passed (CAS group SKIPPED — not a deployment acceptance run)");
  } else {
    console.log("\nall smoke assertions passed");
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
