/**
 * Container Apps 的 CPU/内存必须是固定组合之一。
 *
 * Consumption 计划不接受任意取值,只接受下表里的八种搭配。踩中时的失败发生
 * 在 ARM 的 preflight 校验(`ContainerAppInvalidResourceTotal`)——`az bicep
 * build` 编译得过、what-if 也照常打印出变更,要等真的 create 才报错,而那时
 * 镜像已经构建完、部署链路已经跑了大半。
 *
 * 这张表来自 Azure 的错误信息本身,不是猜的。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGES = join(ROOT, "packages");

/** cpu -> memory,Consumption 计划允许的全部组合。 */
const ALLOWED = new Map([
  ["0.25", "0.5Gi"],
  ["0.5", "1.0Gi"],
  ["0.75", "1.5Gi"],
  ["1.0", "2.0Gi"],
  ["1.25", "2.5Gi"],
  ["1.5", "3.0Gi"],
  ["1.75", "3.5Gi"],
  ["2.0", "4.0Gi"],
]);

/** "4Gi" 与 "4.0Gi" 是同一个值,Azure 的表用后者。 */
function normalizeMemory(value) {
  const match = /^([0-9.]+)Gi$/.exec(value);
  if (!match) return value;
  return `${Number(match[1]).toFixed(1)}Gi`;
}

const services = readdirSync(PACKAGES)
  .filter(name => name.startsWith("azure-"))
  .map(name => ({ name, path: join(PACKAGES, name, "azure.service.json") }))
  .filter(entry => existsSync(entry.path))
  .map(entry => ({ ...entry, config: JSON.parse(readFileSync(entry.path, "utf8")) }));

describe("Azure 容器资源组合", () => {
  test("至少发现一个 azure.service.json", () => {
    expect(services.length).toBeGreaterThan(0);
  });

  test.each(services.map(s => [s.name, s]))(
    "%s: cpu/memory 是 Consumption 计划允许的组合",
    (_name, service) => {
      const { cpu, memory } = service.config;
      // 两个都不写 = 用 container-app.bicep 的默认值(0.5/1Gi),本来就合法。
      if (cpu === undefined && memory === undefined) return;
      expect(cpu, "配了 memory 就必须同时配 cpu").toBeTypeOf("string");
      expect(memory, "配了 cpu 就必须同时配 memory").toBeTypeOf("string");
      expect(
        ALLOWED.has(cpu),
        `cpu=${cpu} 不在允许集合 ${[...ALLOWED.keys()].join(", ")} 里`,
      ).toBe(true);
      expect(
        normalizeMemory(memory),
        `cpu=${cpu} 只能搭配 memory=${ALLOWED.get(cpu)}`,
      ).toBe(ALLOWED.get(cpu));
    },
  );

  test.each(services.map(s => [s.name, s]))(
    "%s: maxUploadBytes 若配置则是正整数，且远小于容器内存",
    (_name, service) => {
      const { maxUploadBytes, memory } = service.config;
      if (maxUploadBytes === undefined) return;
      expect(Number.isSafeInteger(maxUploadBytes)).toBe(true);
      expect(maxUploadBytes).toBeGreaterThan(0);
      // 导入路径至少驻留三份(formData / arrayBuffer / 文档类型的解压表示),
      // 上限贴近内存等于把 OOM 换个方式再踩一遍。要求 4 倍余量。
      const memoryBytes = Number(/^([0-9.]+)Gi$/.exec(memory ?? "1Gi")?.[1] ?? 1) * 1024 ** 3;
      expect(
        maxUploadBytes * 4,
        `maxUploadBytes=${maxUploadBytes} 相对 memory=${memory} 余量不足`,
      ).toBeLessThanOrEqual(memoryBytes);
    },
  );
});
