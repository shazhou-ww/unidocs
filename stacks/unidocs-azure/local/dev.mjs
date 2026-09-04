import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AZURE_DEV_ENV_FILE, loadAzureDevEnv } from "./dev-env.mjs";

const dockerIndex = process.argv.indexOf("--docker", 2);
if (dockerIndex !== -1) {
  process.argv.splice(dockerIndex, 1);
  console.log("UniDocs Azure already uses Docker Compose for local Postgres.");
}

// 必须在 import scripts/dev.mjs **之前**:它一路往下会 spawn 出 gateway 与
// 各 doc service,而每个子进程拿到的是 spawn 那一刻的 process.env 快照。
// 见 dev-env.mjs 顶部——这是 Azure 侧对齐 Cloudflare 侧 `.dev.vars` 的那一半。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const devEnv = loadAzureDevEnv(ROOT);
// 只报键名,不报值:这些是 API key,而这行会同时进终端和 .dev-*.log。
if (devEnv.loaded.length > 0) {
  console.log(`${AZURE_DEV_ENV_FILE}: loaded ${devEnv.loaded.join(", ")}`);
}

process.env.UNIDOCS_LOCAL_PLATFORM = "azure";
await import("../../../scripts/dev.mjs");
