/**
 * 内核不知道平台（spec 4.4 规则 1）。
 *
 * 按目录扫而不是按包扫:同包的 doc-type-handler.ts / session-handler.ts
 * 本来就要用 Request / Response —— 它们是 HTTP 外壳,不在 agent 内核里。
 * 这是不新建包所付的唯一代价:拿不到"整包 tsconfig 禁用平台类型"那道更硬
 * 的保险,只能靠目录级扫描。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const KERNEL = join(import.meta.dirname, "..", "..", "..",
  "packages", "doctype-server-common", "src", "agent");

// spec 4.4 原文只禁 `Request` / `Response` / `DurableObject*` / `@cloudflare/*` /
// `@azure/*` 五项;而 spec 4.2 的内核文件树把 `providers/` 放在内核里,LLM
// provider 本质就是 HTTP 客户端,必须能发请求。`fetch` 是 Workers / Node /
// Deno 都有的 Web 标准,不是平台标记。
const FORBIDDEN = [
  /\bDurableObject\w*/, /\bRequest\b/, /\bResponse\b/,
  /@cloudflare\//, /@azure\//, /\bWebSocket\w*/,
];

const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.some(ext => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = walk(KERNEL);

describe("agent 内核不认识任何平台", () => {
  test("内核目录里有文件（防止 walk 静默扫空）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map(f => [f.slice(f.indexOf("packages")), f]))(
    "%s 不出现平台标识符",
    (_rel, full) => {
      const src = readFileSync(full, "utf8");
      const hits = FORBIDDEN.filter(re => re.test(src)).map(String);
      expect(hits, `平台标识符不该出现在内核里：${hits.join(", ")}`).toEqual([]);
    },
  );
});
