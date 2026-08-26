/**
 * 本地 Azure 栈的端口布局。
 *
 * 无依赖(连 node: 内置模块都不需要)是刻意的,与 `stacks/cloudflare/local/doc-types.mjs`
 * 同一条约定:`dev.mjs` 要在 import 任何重家伙(pg、@azure/storage-blob、
 * esbuild、Miniflare)之前就把端口算出来并探测占用,而纯逻辑也才能脱离
 * Docker 单测。
 *
 * 端口段与 Miniflare 侧(8787/8788/8789)刻意分开,两套栈可以同时跑 ——
 * docx 的 CAS 过渡形态正需要这一点(见 spec §6)。
 *
 * 这个模块本身不知道有哪些 doc type —— 那份表由调用方传入 `portBases`
 * (见 `azurePortLayout` 的文档注释)。
 */

export const AZURE_GATEWAY_PORT = 41787;
export const AZURE_PORT_STRIDE = 10;

/**
 * `portBases` 是必填的:本模块刻意零依赖,读不了
 * packages/azure-<name>/azure.service.json。由调用方从
 * `stacks/azure/doc-types.mjs` 的 `azureDocTypePortBases()` 传进来。
 * 这样"有哪些 doc type"只有一个来源,而端口算法仍然可以脱离文件系统单测。
 */
export function azurePortLayout({ docTypes = ["markdown"], portBases, replicas = 2 } = {}) {
  if (!portBases || typeof portBases !== "object") {
    throw new Error(
      "azurePortLayout() requires portBases: pass azureDocTypePortBases(readAzureDocTypes()) " +
        "from stacks/azure/doc-types.mjs. (This module stays dependency-free on purpose and " +
        "cannot read packages/azure-*/azure.service.json itself.)",
    );
  }
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error(`replicas must be a positive integer, got ${replicas}`);
  }
  // 段内第一个端口给代理,其余给副本 —— 所以副本上限是 STRIDE - 1。
  if (replicas > AZURE_PORT_STRIDE - 1) {
    throw new Error(
      `replicas=${replicas} overflows the ${AZURE_PORT_STRIDE}-port band each doc type gets ` +
        `(max ${AZURE_PORT_STRIDE - 1}); widen AZURE_PORT_STRIDE if you really need more`,
    );
  }

  const result = { gateway: AZURE_GATEWAY_PORT, docTypes: {} };
  for (const name of docTypes) {
    const base = portBases[name];
    if (base === undefined) {
      throw new Error(
        `Unknown Azure doc type: ${name}. Known: ${Object.keys(portBases).join(", ")}`,
      );
    }
    result.docTypes[name] = {
      proxy: base,
      replicas: Array.from({ length: replicas }, (_, i) => base + 1 + i),
    };
  }
  return result;
}

export function allAzurePorts(layout) {
  const ports = [layout.gateway];
  for (const spec of Object.values(layout.docTypes)) {
    ports.push(spec.proxy, ...spec.replicas);
  }
  return ports.sort((a, b) => a - b);
}

export function describeAzurePorts(layout) {
  const described = {
    [layout.gateway]: "expected by the azure-gateway service this run is about to spawn",
  };
  for (const [name, spec] of Object.entries(layout.docTypes)) {
    described[spec.proxy] =
      `expected by the round-robin proxy that stands in for the platform ingress in front of azure-${name}`;
    spec.replicas.forEach((port, i) => {
      described[port] = `expected by azure-${name} replica ${i + 1} this run is about to spawn`;
    });
  }
  return described;
}
