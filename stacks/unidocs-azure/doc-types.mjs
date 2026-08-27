/**
 * Azure doc type 的唯一事实来源:扫 `packages/azure-* / azure.service.json`。
 *
 * 为什么读文件的逻辑在这里而不在 `local/ports.mjs`:后者刻意零依赖(连
 * `node:` 内置模块都不 import),`dev.mjs` 要在 import 任何重家伙之前就用
 * 它算出端口。所以分工是——本模块负责「有哪些 doc type、它们声明了什么」,
 * `ports.mjs` 负责「给定这些声明,端口怎么排」,后者收表不持有表。
 *
 * 每个字段缺失或类型不对都点名报错,绝不静默取默认值:这份 json 一旦可以
 * 被默默兜底,它就不再是唯一事实来源了。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 字段名 -> 校验器。顺序即报错时的检查顺序,保持与 json 里的书写顺序一致。 */
const FIELDS = {
  docType: (v) => typeof v === "string" && v.length > 0,
  targetPort: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  localPortBase: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  minReplicas: (v) => Number.isInteger(v) && v >= 1,
  maxReplicas: (v) => Number.isInteger(v) && v >= 1,
  needsCas: (v) => typeof v === "boolean",
};

/**
 * 读出全部 Azure doc type 的声明,按 docType 字典序返回。
 *
 * 排序不是审美:`platform.bicep` 的 `docTypes` 数组决定循环资源的
 * `copyIndex()` 顺序,而目录扫描顺序在不同文件系统上不保证一致。稳定排序
 * 让同一份仓库在任何机器上展开出同一个部署形状。
 */
export function readAzureDocTypes(repoRoot = DEFAULT_ROOT) {
  const packagesDir = join(repoRoot, "packages");
  const table = {};
  const dirs = readdirSync(packagesDir).filter((d) => d.startsWith("azure-")).sort();

  for (const dir of dirs) {
    const rel = `packages/${dir}/azure.service.json`;
    const path = join(packagesDir, dir, "azure.service.json");
    if (!existsSync(path)) continue;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${rel} is not valid JSON: ${err.message}`);
    }

    // 没有 docType 字段的不是 doc type —— packages/azure-gateway 那份就是
    // 这样,它是 --gateway 自己的参数。按字段而不是按目录名排除,这样加
    // 新的非 doc type 包不需要改这里。
    if (!("docType" in parsed)) continue;

    for (const [field, valid] of Object.entries(FIELDS)) {
      if (!(field in parsed)) {
        throw new Error(`${rel} is missing required field ${field}`);
      }
      if (!valid(parsed[field])) {
        throw new Error(
          `${rel} has an invalid ${field}: ${JSON.stringify(parsed[field])}`,
        );
      }
    }

    const expected = dir.slice("azure-".length);
    if (parsed.docType !== expected) {
      throw new Error(
        `${rel} has docType ${JSON.stringify(parsed.docType)} but lives in ` +
          `packages/${dir}, which implies ${JSON.stringify(expected)}. ` +
          "The directory name drives the image name, the Container App name and " +
          "the database name, so a mismatch only surfaces at real deployment.",
      );
    }

    table[parsed.docType] = {
      docType: parsed.docType,
      targetPort: parsed.targetPort,
      localPortBase: parsed.localPortBase,
      minReplicas: parsed.minReplicas,
      maxReplicas: parsed.maxReplicas,
      needsCas: parsed.needsCas,
    };
  }

  const seen = new Map();
  for (const entry of Object.values(table)) {
    const clash = seen.get(entry.localPortBase);
    if (clash) {
      throw new Error(
        `localPortBase ${entry.localPortBase} is claimed by both ${clash} and ` +
          `${entry.docType}; each doc type needs its own band.`,
      );
    }
    seen.set(entry.localPortBase, entry.docType);
  }

  return table;
}

/** `azurePortLayout({ portBases })` 要的形状。 */
export function azureDocTypePortBases(table) {
  return Object.fromEntries(
    Object.values(table).map((entry) => [entry.docType, entry.localPortBase]),
  );
}
