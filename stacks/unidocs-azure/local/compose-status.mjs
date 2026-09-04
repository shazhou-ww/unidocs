/**
 * 「本仓库的 compose 项目是不是正占着某个宿主端口」。
 *
 * `scripts/dev.mjs` 的启动预检坚持 5433 必须空闲。这条规则本身是对的——它
 * 防的不是"重复启动",而是**认错人**:`postgres://…@localhost:5433` 这个
 * 连接串不关心对面是谁,陌生人的 Postgres 一样连得上,migrations 会直接往
 * 别人的库上跑。所以它不能删。
 *
 * 但它问错了问题。正常 Ctrl-C 之后的稳态就是"我们上一轮那个 Postgres 容器
 * 还在 5433 上"——`docker compose up -d` 幂等,本来完全该复用它,却被自己的
 * 上一轮挡住,于是每次重启都要先 `pnpm azure:down`。
 *
 * 把「端口空不空」换成「端口上的人是不是我们」就同时满足两边。判据是同一个
 * 端口只能被一个进程绑定:既然我们 compose 项目里的服务正在跑、且发布着这
 * 个端口,那这个端口上的就必然是它,不可能是别人。
 *
 * 判定逻辑(`composeOwnsPort`)只吃字符串、不 exec,于是可以被单测钉住(与
 * `doc-types.mjs` / `ports.mjs` 同一个思路);`composeOwnsPortNow()` 是它上面
 * 那层薄薄的 exec 包装,除了 try/catch 不含任何逻辑。
 *
 * 两个调用方都走这里,因为这条检查在仓库里有两份:`scripts/dev.mjs` 的启动
 * 预检(在 import runtime.mjs 这个重家伙之前跑),和 `runtime.mjs` 自己的
 * `assertPortsFree()`。少放行任何一份,另一份都会照样把你挡在门外——这就是
 * 本轮第一次修复只改了前者、结果 5433 依然报错的原因。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMPOSE_FILE = join(ROOT, "packages/azure-sdk/docker-compose.yml");

/**
 * `psJson` 是 `docker compose ps --format json` 的原样输出:JSONL,一行一个
 * 容器。返回 true 当且仅当其中有**正在跑**的容器把 `port` 发布到了宿主。
 *
 * 任何解析不出来的输入一律返回 false —— docker CLI 换了输出格式、或者这里
 * 收到的其实是一行错误信息时,要退回到原来那条严格的端口检查,而不是把
 * `pnpm dev` 整个搞崩,更不是反过来放行一个来历不明的 5433。
 */
export function composeOwnsPort(psJson, port) {
  for (const line of String(psJson ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || entry.State !== "running" || !Array.isArray(entry.Publishers)) continue;
    if (entry.Publishers.some((p) => p && p.PublishedPort === port)) return true;
  }
  return false;
}

/**
 * 现在去问一次 docker,再交给 `composeOwnsPort()` 判定。
 *
 * 任何失败都吞掉、当作"不是我们的":这是一条**放宽**检查的旁路,拿不到信息
 * 时该退回到原来那条严格的端口检查,而不是让 `pnpm dev` 因为 docker CLI 的
 * 一次抽风就起不来,更不是反过来放行一个来历不明的 5433。
 */
export function composeOwnsPortNow(port) {
  let out;
  try {
    out = execFileSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "ps", "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return false;
  }
  return composeOwnsPort(out, port);
}
