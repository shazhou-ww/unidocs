# 阶段 0:表征测试安全网 实施计划

> **Superseded CAS contract (2026-08-26):** This is a historical implementation
> record. Owner assignments, portable-node HTTP, shared keys, tenantless routes,
> and tenant-only CAS namespaces are not current guidance. See
> [CAS Middleware](./2026-08-26-cas-middleware.md) and
> [CAS Architecture](../../cas-architecture.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在重构 `editor-do.ts` 之前,用可重复运行的自动化测试锁住它当前的全部行为,使阶段 1 的重构有一个客观的"没改坏"判据。

**Architecture:** 全部测试基于 `startLocalRuntime()`(进程内 Miniflare,不需要 Docker),通过 Gateway 的公开 HTTP 接口驱动,再用 Miniflare 的 `getD1Database` / `getR2Bucket` 直接读底层存储做断言。唯一的产品行为注入点是一个代理式的假 CAS worker,它把除 `/_internal/root-refs` 之外的请求原样转发给真 CAS。

**Tech Stack:** Node 24、vitest 3、Miniflare 4(经 `convertV4MiniflareOptions`)、esbuild(由 `startLocalRuntime` 内部调用)

## Global Constraints

- **不改产品代码。** 本阶段禁止修改 `packages/` 下的任何文件。只有 Task 5 允许修改 `scripts/`,那是本地开发基础设施,不是产品代码。
- `scripts/doc-types.mjs` 必须保持零依赖 —— 只允许 `import { join } from "node:path"`。任何纯逻辑放这里,不要放进 `local-runtime.mjs`。
- 测试用 vitest,仓库里没有 vitest 配置文件,靠 `package.json` 的脚本指定文件。
- **端口不得与既有测试冲突。** 已占用:8787-8789(`pnpm dev`)、18787-19089、28787-28788、29787-29789。本计划使用 31787-31791 与 32787-32789。
- **这些是表征测试,不是 TDD。** Task 1-4、Task 6 的测试断言的是**已经存在**的行为,因此写完第一次运行就应该是绿的。如果是红的,说明要么测试写错了,要么发现了真 bug —— 两种情况都要停下来查清楚,**禁止靠放宽断言让它变绿**。只有 Task 5 是真正的 TDD(新增基础设施,先红后绿)。
- 每个 Task 结束时提交一次,提交信息用 conventional commits 前缀(`test:` / `feat(dev):`)。
- 全量验证命令:`pnpm test:local`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `scripts/editor-characterization.test.mjs` | 新建。共享一个 runtime 的表征测试:并发 409、快照阈值、rollback、clone、export/import |
| `scripts/editor-restart.test.mjs` | 新建。单独一个文件,因为它要 dispose 再重启 runtime,和共享 runtime 的文件不能混 |
| `scripts/cas-rollback.test.mjs` | 新建。CAS root-refs 失败时的 delta 回滚,需要故障注入的 runtime |
| `scripts/doc-types.mjs` | 修改。新增假 CAS worker 的定义与 `buildWorkers({ casFault })` 分支 |
| `scripts/local-runtime.mjs` | 修改。把 `casFault` 选项透传给 `buildWorkers` |
| `scripts/doc-types.test.mjs` | 修改。为 `casFault` 分支补纯单测 |
| `package.json` | 修改。三个新测试文件加进 `test:local` |

---

## Task 1: 测试骨架 + 并发写入的 409

锁住整个重构中风险最高的一条性质:两个 `baseVersion` 相同的 apply 并发到达时,恰好一个成功。阶段 1 要把这条性质的实现从"DO 单线程 + 内存版本检查"换成"数据库主键冲突",这个测试是换之前换之后都必须通过的同一份断言。

**Files:**
- Create: `scripts/editor-characterization.test.mjs`
- Modify: `package.json`(`scripts.test:local`)

**Interfaces:**
- Consumes: `startLocalRuntime({ docTypes, ports })` from `scripts/local-runtime.mjs`,返回 `{ mf, urls, docTypes, dispose() }`
- Produces: 本文件内的三个辅助函数 `closeFetch(url, init)`、`createDoc(userId)`、`applyOp(docId, baseVersion, content, userId)`,Task 2 与 Task 4 会继续往这个文件里加测试并复用它们

- [ ] **Step 1: 建立测试文件**

创建 `scripts/editor-characterization.test.mjs`:

```js
import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "./local-runtime.mjs";

let runtime;
const GW = () => runtime.urls.gateway;

/**
 * Miniflare 的 unsafeDirectSockets 在 keep-alive 连接上偶发挂起,
 * 既有的 e2e 测试统一加 Connection: close,这里沿用。
 */
function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

async function createDoc(userId) {
  const res = await closeFetch(`${GW()}/users/${userId}/docs/markdown/`, {
    method: "POST",
  });
  const body = await res.json();
  expect(body.success, JSON.stringify(body)).toBe(true);
  return body.docId;
}

function applyOp(docId, baseVersion, content, userId) {
  return closeFetch(`${GW()}/users/${userId}/docs/markdown/${docId}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseVersion,
      description: `set ${content}`,
      operations: [{ kind: "setContent", payload: { content } }],
    }),
  });
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 31787, markdown: 31788 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("并发的两个同 baseVersion apply:恰好一个成功,另一个 409 且带当前版本", async () => {
  const docId = await createDoc("concurrent-user");

  const [a, b] = await Promise.all([
    applyOp(docId, 1, "A", "concurrent-user"),
    applyOp(docId, 1, "B", "concurrent-user"),
  ]);

  expect([a.status, b.status].sort()).toEqual([200, 409]);

  const conflict = a.status === 409 ? a : b;
  await expect(conflict.json()).resolves.toMatchObject({
    success: false,
    version: 2,
  });

  // 只有一条 delta 落地:创建时的 version 1,加上胜出的那个 version 2
  const history = await closeFetch(
    `${GW()}/users/concurrent-user/docs/markdown/${docId}/history`,
  );
  const { data } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1, 2]);
});
```

- [ ] **Step 2: 把新文件加进 test:local**

修改 `package.json`,把 `scripts.test:local` 改成:

```json
"test:local": "vitest run scripts/doc-types.test.mjs scripts/local-runtime.test.mjs scripts/cas-e2e.test.mjs scripts/docx-image-e2e.test.mjs scripts/editor-characterization.test.mjs"
```

- [ ] **Step 3: 运行,确认通过**

Run: `pnpm exec vitest run scripts/editor-characterization.test.mjs`
Expected: 1 passed。

如果是红的:先看是不是 `data.map(...)` 得到的是 `[2]` 而不是 `[1, 2]`(说明创建时不写 delta),这时改断言是对的,因为那才是真实行为。其他任何失败都要先查清原因再动断言。

- [ ] **Step 4: 提交**

```bash
git add scripts/editor-characterization.test.mjs package.json
git commit -m "test(sdk): characterize concurrent apply version conflict"
```

---

## Task 2: 快照阈值 DELTA_THRESHOLD = 20

现有 22 个 treespec e2e 一条都没触发过自动快照(每条分支最多 2 次 apply,版本最高到 5),这是重构最大的盲区之一。这个测试补上它,同时锁住"第 20 个 delta 处同时写 R2 与 D1"这条写入顺序不变量的可观测结果。

**Files:**
- Modify: `scripts/editor-characterization.test.mjs`(追加一个 test)

**Interfaces:**
- Consumes: Task 1 的 `createDoc` / `applyOp` / `closeFetch` / `runtime`
- Produces: 无

- [ ] **Step 1: 追加快照阈值测试**

在 `scripts/editor-characterization.test.mjs` 末尾追加:

```js
test("初始快照 version 1 + 阈值快照 version 21:两次快照的 R2 对象都存在,D1 记录完整", async () => {
  const userId = "snapshot-user";
  const docId = await createDoc(userId);

  // POST /_internal/create 会立刻把 version 1 快照到 R2 + D1。
  // 之后 apply 25 次,版本推进到 26。#shouldSnapshot() 数的是
  // version > lastSnapshotVersion 的 delta 数;lastSnapshotVersion = 1,
  // 因此到 version 21 时累积 20 个新 delta,触发第二次快照。
  for (let baseVersion = 1; baseVersion <= 25; baseVersion += 1) {
    const res = await applyOp(docId, baseVersion, `content ${baseVersion}`, userId);
    expect(res.status, `apply at baseVersion ${baseVersion}`).toBe(200);
  }

  const db = await runtime.mf.getD1Database("SNAPSHOTS_DB", "unidocs-markdown");
  const rows = await db
    .prepare("SELECT version, hash FROM snapshots WHERE doc_id = ? ORDER BY version ASC")
    .bind(docId)
    .all();

  expect(rows.results.map((row) => row.version)).toEqual([1, 21]);

  const bucket = await runtime.mf.getR2Bucket("CAS", "unidocs-markdown");
  for (const snap of rows.results) {
    const object = await bucket.get(snap.hash);
    expect(object, `R2 缺少快照对象 ${snap.hash}`).not.toBeNull();
  }
}, 60_000);
```

- [ ] **Step 2: 运行,确认通过**

Run: `pnpm exec vitest run scripts/editor-characterization.test.mjs`
Expected: 2 passed。

这个测试要跑 26 次 HTTP 往返,比其他测试慢,超时已设为 60 秒。如果 `rows.results` 是空的,先确认 `runtime.mf.getD1Database` 的第二个参数是否应为 `"unidocs-markdown"` —— D1 绑定 `SNAPSHOTS_DB` 同时存在于 gateway 和 doc-type worker 上,两者指向同一个库,任一个都能读到。

- [ ] **Step 3: 提交**

```bash
git add scripts/editor-characterization.test.mjs
git commit -m "test(sdk): characterize automatic snapshot at delta threshold"
```

---

## Task 3: 重启恢复与 snapshot-replay 路径

DO 被驱逐或进程重启后,文档要能从"最近快照 + 其后的 delta"重建。阶段 1 之后 Azure 侧**每次冷请求**都走这条路径,所以它从边缘路径升级成主路径,必须先锁住。

**执行期修正(重要)**:原计划设想"重启 runtime"就能触发 replay,这是错的。`#saveSnapshotKV()` 在每次 apply 后无条件刷新 DO storage 里的 `KEY_SNAPSHOT`,所以优雅关停后 `#ensureLoaded()` 的 `SELECT ... FROM deltas WHERE version > ?` 恒为 0 行 —— 一条 delta 都不会重放。只有崩溃发生在 delta INSERT 与快照 PUT 之间才会留下陈旧快照,测试无法制造。

因此本任务实际产出两个测试:

1. **优雅重启后持久化状态完整** —— 版本与内容不变。这仍是真不变量(Azure 冷启动就是读持久化状态),只是不涉及 replay。
2. **rollback 走 snapshot-replay** —— rollback 是测试里唯一能稳定触发"加载不晚于目标版本的最近 R2 快照 → replay 其后的 delta"的入口。apply 22 次(阈值快照落在 version 21),rollback 到 version 22,强制加载快照 21 并重放 delta 22,得到内容 `# v21`、版本 24。

单独一个测试文件,因为它需要在测试中途 dispose 并重启 runtime,与共享 runtime 的文件不兼容。

**Files:**
- Create: `scripts/editor-restart.test.mjs`
- Modify: `package.json`(`scripts.test:local`)

**Interfaces:**
- Consumes: `startLocalRuntime({ docTypes, ports, persistPath })`
- Produces: 无

- [ ] **Step 1: 建立重启测试**

创建 `scripts/editor-restart.test.mjs`:

```js
import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "./local-runtime.mjs";

const PORTS = { gateway: 31790, markdown: 31791 };

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

test("优雅重启后从持久化存储恢复,版本与内容保持不变", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-restart-"));
  const userId = "restart-user";

  let runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
    persistPath,
  });

  let docId;
  try {
    const create = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/`,
      { method: "POST" },
    );
    ({ docId } = await create.json());

    // 21 次 apply 让版本走到 22。#saveSnapshotKV() 在每次 apply 后都无条件刷新 KV 快照,
    // 因此优雅重启后 KV 快照的 version 等于当前版本,不会有任何 delta 可重放。
    // 这个测试验证的是持久化状态的完整性:优雅重启后版本与内容原样恢复。
    for (let baseVersion = 1; baseVersion <= 21; baseVersion += 1) {
      const res = await closeFetch(
        `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseVersion,
            description: `set ${baseVersion}`,
            operations: [
              { kind: "setContent", payload: { content: `# v${baseVersion}` } },
            ],
          }),
        },
      );
      expect(res.status, `apply at baseVersion ${baseVersion}`).toBe(200);
    }
  } finally {
    await runtime.dispose();
  }

  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: PORTS,
    persistPath,
  });

  try {
    const query = await closeFetch(
      `${runtime.urls.gateway}/users/${userId}/docs/markdown/${docId}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "getContent" }),
      },
    );
    const body = await query.json();
    expect(body.success, JSON.stringify(body)).toBe(true);
    expect(body.version).toBe(22);
    expect(body.data).toBe("# v21");
  } finally {
    await runtime.dispose();
    await rm(persistPath, { recursive: true, force: true });
  }
}, 180_000);
```

- [ ] **Step 2: 把新文件加进 test:local**

在 `package.json` 的 `scripts.test:local` 末尾追加 ` scripts/editor-restart.test.mjs`。

- [ ] **Step 3: 运行,确认通过**

Run: `pnpm exec vitest run scripts/editor-restart.test.mjs`
Expected: 1 passed。

这个测试要启动两次 Miniflare(每次含一轮 esbuild 打包),慢是正常的,超时已设为 180 秒。如果第二次启动报端口被占用,说明第一次 `dispose()` 没等干净 —— 那是真问题,记录下来,不要靠换端口绕过。

- [ ] **Step 4: 提交**

```bash
git add scripts/editor-restart.test.mjs package.json
git commit -m "test(sdk): characterize snapshot replay recovery across restarts"
```

---

## Task 4: rollback、clone、export/import 往返

这三条路径 treespec 已经覆盖,但覆盖点都在版本 5 以内,且断言写在 YAML 里、与运行时耦合。这里用同一个 runtime 复刻一份进程内版本,阶段 2 换 Azure 后端时这份测试可以直接参数化重跑,YAML 那份不行。

**Files:**
- Modify: `scripts/editor-characterization.test.mjs`(追加三个 test)

**Interfaces:**
- Consumes: Task 1 的 `createDoc` / `applyOp` / `closeFetch` / `runtime`
- Produces: 无

- [ ] **Step 1: 追加 rollback 测试**

在 `scripts/editor-characterization.test.mjs` 末尾追加:

```js
test("rollback 到旧版本:内容回退,版本向前推进,历史保留全部 delta", async () => {
  const userId = "rollback-user";
  const docId = await createDoc(userId);

  expect((await applyOp(docId, 1, "A", userId)).status).toBe(200); // v2
  expect((await applyOp(docId, 2, "B", userId)).status).toBe(200); // v3

  const rollback = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/rollback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2 }),
    },
  );
  await expect(rollback.json()).resolves.toMatchObject({
    success: true,
    version: 4,
  });

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("A");
  expect(body.version).toBe(4);

  // rollback 是一条合成 delta,不删除任何历史
  const history = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/history`,
  );
  const { data } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
  expect(data[3].description).toBe("Rollback to version 2");
  expect(data[3].operations).toEqual([]);
});
```

- [ ] **Step 2: 追加 clone 测试**

继续追加:

```js
test("clone 走 snapshot hash + init_from_hash:新文档内容相同,版本从 1 开始", async () => {
  const userId = "clone-user";
  const sourceId = await createDoc(userId);
  expect((await applyOp(sourceId, 1, "cloned content", userId)).status).toBe(200);

  const snapshot = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${sourceId}/snapshot`,
  );
  const snap = await snapshot.json();
  expect(snap.success, JSON.stringify(snap)).toBe(true);
  expect(snap.hash).toEqual(expect.any(String));

  const targetId = `${sourceId}-clone`;
  const adopt = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${targetId}/init_from_hash`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: snap.hash, sourceVersion: snap.version }),
    },
  );
  await expect(adopt.json()).resolves.toMatchObject({
    success: true,
    docId: targetId,
  });

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${targetId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("cloned content");
  expect(body.version).toBe(1);
});
```

- [ ] **Step 3: 追加 export/import 往返测试**

继续追加:

```js
test("export 的字节导入成新文档后内容一致", async () => {
  const userId = "export-user";
  const docId = await createDoc(userId);
  expect((await applyOp(docId, 1, "# Round Trip", userId)).status).toBe(200);

  const exported = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}/export`,
  );
  expect(exported.ok).toBe(true);
  const bytes = new Uint8Array(await exported.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);

  const form = new FormData();
  form.append("file", new File([bytes], "exported.md", { type: "text/markdown" }));

  const imported = await closeFetch(`${GW()}/users/${userId}/docs/markdown/`, {
    method: "POST",
    headers: { "X-Doc-Id": `${docId}-imported` },
    body: form,
  });
  const importedBody = await imported.json();
  expect(importedBody.success, JSON.stringify(importedBody)).toBe(true);

  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/markdown/${docId}-imported/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getContent" }),
    },
  );
  const body = await query.json();
  expect(body.data).toBe("# Round Trip");
});
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run scripts/editor-characterization.test.mjs`
Expected: 5 passed。

`closeFetch` 会给 FormData 请求也带上 `Connection: close`,但不要手工设置 `Content-Type` —— 让 `fetch` 自己生成 multipart boundary。

- [ ] **Step 5: 提交**

```bash
git add scripts/editor-characterization.test.mjs
git commit -m "test(sdk): characterize rollback, clone and export/import round trip"
```

---

## Task 5: CAS 故障注入基础设施

Task 6 要断言"`updateRootRefs` 失败时刚写入的 delta 被删除",这需要让 CAS 的 root-refs 端点失败、而其余端点正常(lease 与读内容都必须成功,否则 apply 在更早的步骤就挂了)。做法是插一个代理 worker:除 `/_internal/root-refs` 之外全部原样转发给真 CAS。

这是本计划里**唯一的真 TDD 任务** —— 先写红的单测,再实现。

**Files:**
- Modify: `scripts/doc-types.mjs`
- Modify: `scripts/local-runtime.mjs`(`startLocalRuntime` 签名与透传)
- Test: `scripts/doc-types.test.mjs`

**Interfaces:**
- Produces:
  - `CAS_FAULT_WORKER: string` —— 假 worker 的名字,值为 `"unidocs-cas-fault"`
  - `buildWorkers({ docTypes, host, ports, bundleDir, casFault })` —— 新增可选布尔参数 `casFault`,默认 `false`
  - `startLocalRuntime({ ..., casFault })` —— 新增可选布尔参数,默认 `false`,透传给 `buildWorkers`
- Consumes: 既有的 `CAS_WORKER`、`GATEWAY_WORKER`、`INTERNAL_TOKEN`、`DOC_TYPES`

- [ ] **Step 1: 写失败的单测**

在 `scripts/doc-types.test.mjs` 末尾追加:

```js
test("casFault 为 true 时,doc-type worker 指向假 CAS,gateway 仍指向真 CAS", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { gateway: 8787, docx: 8789 },
    bundleDir: "/tmp/bundles",
    casFault: true,
  });

  const names = workers.map((w) => w.name);
  expect(names).toContain(CAS_FAULT_WORKER);
  expect(names).toContain(CAS_WORKER);

  const gateway = workers.find((w) => w.name === GATEWAY_WORKER);
  expect(gateway.serviceBindings.CAS_SERVICE).toBe(CAS_WORKER);

  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_FAULT_WORKER);

  const fault = workers.find((w) => w.name === CAS_FAULT_WORKER);
  expect(fault.serviceBindings.CAS_UPSTREAM).toBe(CAS_WORKER);
  expect(fault.script).toContain("/_internal/root-refs");
});

test("casFault 默认关闭时,不产生假 CAS worker", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { gateway: 8787, docx: 8789 },
    bundleDir: "/tmp/bundles",
  });

  expect(workers.map((w) => w.name)).not.toContain(CAS_FAULT_WORKER);
  const docx = workers.find((w) => w.name === "unidocs-docx");
  expect(docx.serviceBindings.CAS_SERVICE).toBe(CAS_WORKER);
});
```

同时把该文件顶部的导入块整个替换成(新增了三个符号):

```js
import {
  buildWorkers,
  bundleTargets,
  CAS_FAULT_WORKER,
  CAS_WORKER,
  DOC_TYPES,
  GATEWAY_WORKER,
  parseDocTypes,
  registryEntries,
  resolvePorts,
} from "./doc-types.mjs";
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run scripts/doc-types.test.mjs`
Expected: FAIL,报 `CAS_FAULT_WORKER` 未定义(import 得到 `undefined`)。

- [ ] **Step 3: 实现假 CAS worker 的定义**

在 `scripts/doc-types.mjs` 里,紧跟 `export const CAS_WORKER = "unidocs-cas";` 之后插入:

```js
/** 故障注入用的假 CAS,只在测试里启用。 */
export const CAS_FAULT_WORKER = "unidocs-cas-fault";

/**
 * 代理式假 CAS:除 root-refs 外全部原样转发给真 CAS,
 * 使 lease 与读内容照常成功,只让引用计数写入失败。
 */
export const CAS_FAULT_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_internal/root-refs") {
      return Response.json({ error: "injected root-refs failure" }, { status: 503 });
    }
    return env.CAS_UPSTREAM.fetch(request);
  },
};
`;
```

- [ ] **Step 4: 实现 buildWorkers 的 casFault 分支**

把 `scripts/doc-types.mjs` 的 `buildWorkers` 签名改成:

```js
export function buildWorkers({ docTypes, host, ports, bundleDir, casFault = false }) {
```

在 `workers` 数组字面量之后、`for (const name of docTypes)` 循环之前插入:

```js
  if (casFault) {
    workers.push({
      name: CAS_FAULT_WORKER,
      modules: true,
      script: CAS_FAULT_SCRIPT,
      compatibilityDate: COMPATIBILITY_DATE,
      bindings,
      serviceBindings: { CAS_UPSTREAM: CAS_WORKER },
    });
  }
```

再把循环体里 doc-type worker 的那行 service binding 改成:

```js
      serviceBindings: { CAS_SERVICE: casFault ? CAS_FAULT_WORKER : CAS_WORKER },
```

gateway 的 `serviceBindings` 保持不动,它必须继续连真 CAS,否则测试无法上传图片。

- [ ] **Step 5: 运行,确认通过**

Run: `pnpm exec vitest run scripts/doc-types.test.mjs`
Expected: 全部 passed,含新增的 2 个。

- [ ] **Step 6: 在 startLocalRuntime 里透传**

修改 `scripts/local-runtime.mjs` 的 `startLocalRuntime` 签名,新增一个参数:

```js
export async function startLocalRuntime({
  host = "127.0.0.1",
  docTypes = Object.keys(DOC_TYPES),
  ports: portOverrides = {},
  persistPath,
  casFault = false,
  logLevel = LogLevel.WARN,
} = {}) {
```

并把 `buildWorkers` 的调用改成:

```js
        workers: buildWorkers({ docTypes, host, ports, bundleDir, casFault }),
```

- [ ] **Step 7: 跑一遍完整本地测试,确认没打破既有行为**

Run: `pnpm test:local`
Expected: 全部 passed。`casFault` 默认 `false`,既有测试的 worker 配置应当逐字不变。

- [ ] **Step 8: 提交**

```bash
git add scripts/doc-types.mjs scripts/local-runtime.mjs scripts/doc-types.test.mjs
git commit -m "feat(dev): add CAS fault injection to the local runtime"
```

---

## Task 6: root-refs 失败时 delta 必须回滚

这是 apply 写入顺序里最脆弱的一环:delta 已经写进真相来源,随后的 CAS 引用计数写入失败,必须把那条 delta 删掉,否则文档版本前进了、但它引用的 CAS 节点没有 root 引用,GC 会把节点回收,文档从此损坏。阶段 1 重构 apply 时如果漏掉这段补偿逻辑,只有这个测试能发现。

**Files:**
- Create: `scripts/cas-rollback.test.mjs`
- Modify: `package.json`(`scripts.test:local`)

**Interfaces:**
- Consumes: Task 5 的 `startLocalRuntime({ casFault: true })`;`@unidocs/cas` 的 `encodeHeader` / `computeNodeDigest` / `hashToHex`
- Produces: 无

- [ ] **Step 1: 建立回滚测试**

创建 `scripts/cas-rollback.test.mjs`:

```js
import { afterAll, beforeAll, expect, test } from "vitest";
import { startLocalRuntime } from "./local-runtime.mjs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
} from "../packages/cas/src/index.ts";

const PNG_1x1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

let runtime;
const GW = () => runtime.urls.gateway;

function closeFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["docx"],
    ports: { gateway: 32787, docx: 32789 },
    casFault: true,
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("updateRootRefs 失败时:apply 返回 502,delta 被删除,版本不变", async () => {
  const userId = "rollback-cas-user";

  // 图片经由 gateway 上传,gateway 连的是真 CAS,所以节点是 ready 的。
  const header = encodeHeader(PNG_1x1.length, "image/png", 0);
  const digest = await computeNodeDigest(header, "image/png", [], PNG_1x1);
  const hash = hashToHex(digest);

  const lease = await closeFetch(`${GW()}/users/${userId}/cas/nodes/${hash}`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(PNG_1x1.length),
      "X-CAS-Lease-Duration": "900000",
    },
    body: PNG_1x1,
  });
  expect(lease.ok, await lease.text()).toBe(true);

  const create = await closeFetch(`${GW()}/users/${userId}/docs/docx/`, {
    method: "POST",
  });
  const { docId } = await create.json();

  // editor 连的是假 CAS:lease 与读内容照常成功,只有 root-refs 失败。
  const apply = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseVersion: 1,
        description: "Insert image",
        operations: [
          { kind: "insertImage", payload: { hash, widthPx: 16, altText: "dot" } },
        ],
      }),
    },
  );

  expect(apply.status).toBe(502);
  const applied = await apply.json();
  expect(applied.success).toBe(false);
  expect(applied.error).toContain("CAS root-refs failed");
  expect(applied.version).toBe(1);

  // 那条已写入的 delta 必须被删掉,历史里只剩创建时的 version 1
  const history = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/history`,
  );
  const { data, version } = await history.json();
  expect(data.map((entry) => entry.version)).toEqual([1]);
  expect(version).toBe(1);

  // 文档内容也不能留下那张图
  const query = await closeFetch(
    `${GW()}/users/${userId}/docs/docx/${docId}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "getImages" }),
    },
  );
  const result = await query.json();
  expect(result.success).toBe(true);
  expect(result.data).toEqual([]);
}, 60_000);
```

- [ ] **Step 2: 把新文件加进 test:local**

在 `package.json` 的 `scripts.test:local` 末尾追加 ` scripts/cas-rollback.test.mjs`。

- [ ] **Step 3: 运行,确认通过**

Run: `pnpm exec vitest run scripts/cas-rollback.test.mjs`
Expected: 1 passed。

诊断顺序:如果 `apply.status` 是 400 而不是 502,说明失败发生在 `leaseOpRefs` 或 `config.apply()` 阶段(假 CAS 把不该拦的请求也拦了),检查 `CAS_FAULT_SCRIPT` 的路径判断;如果是 200,说明 `CAS_SERVICE` 没指向假 worker,回 Task 5 检查 `casFault` 是否透传到了 `buildWorkers`。

- [ ] **Step 4: 跑全量验证**

Run: `pnpm test:local`
Expected: 全部 passed。

Run: `pnpm test`
Expected: 全部 passed(各 package 的单测未被触及,应当原样通过)。

- [ ] **Step 5: 提交**

```bash
git add scripts/cas-rollback.test.mjs package.json
git commit -m "test(sdk): characterize delta rollback when CAS root-refs fail"
```

---

## 阶段 0 完成判据

- [ ] `pnpm test:local` 全绿,含本计划新增的 8 个测试
- [ ] `pnpm test` 全绿
- [ ] `packages/` 下零改动:`git diff --stat main -- packages/` 输出为空
- [ ] treespec e2e 未被触及:`git diff --stat main -- tests/` 输出为空

最后一条尤其重要 —— 阶段 1 的验收标准是"22 个 treespec spec 一个都不改",如果阶段 0 就动了它们,那个判据会失效。

treespec 本身需要 Docker(`treespec.yaml` → `e2e/Dockerfile`),`package.json` 里没有对应脚本,本阶段也没碰产品代码,因此用上面两条 `git diff` 判据代替实跑。如果本机有 Docker,跑一次完整 treespec 作为兜底更好,但不是阶段 0 的阻塞项 —— 它是阶段 1 的验收项。

## 未覆盖的部分(有意为之)

- `operator-do.ts` 仍然零覆盖。它的 `llmProvider` 与 `getEditorStub` 都是抛异常的 stub,现在没有可断言的行为;阶段 1 按原样迁入 `server-core`,不新增功能。
- **lease → apply → root-refs 的正常路径**已由既有的 `scripts/docx-image-e2e.test.mjs` 覆盖(上传节点 → insertImage → getImages 查回),本计划不重复,只补它的失败路径(Task 6)。
- 用户级 CAS 服务端(lease / GC / 引用计数)的行为由 `packages/cloudflare-cas/tests/` 与 6 个 treespec CAS spec 覆盖,本阶段不重复。本阶段只覆盖 **editor 与 CAS 的交互边界**,因为那是阶段 1 要动的部分。

---

## 阶段 1 交接说明

阶段 0 执行过程中发现的、会影响阶段 1 的事项。**动 `editor-do.ts` 之前先读这一节。**

### 1. 两处断言会误报,它们不是不变量

`scripts/editor-characterization.test.mjs` 与 `scripts/editor-restart.test.mjs` 里的 `expect(...).toEqual([1, 21])`。

`21` 是两个事实的乘积:`DELTA_THRESHOLD = 20`(真不变量)**和** `/_internal/create` 在 version 1 就立刻写一次全局快照(实现细节)。阶段 1 把快照索引抽进 `BlobCas` + `DocIndex` 端口后,如果 create 不再立即落全局快照,`lastSnapshotVersion` 变成 0,阈值改落 version **20** —— 行为完全没坏,测试却红。

`editor-restart.test.mjs` 里 rollback 的期望版本 `24` 是同一条链的下游,同因同果。

判断标准:红了先确认"两次快照的间隔是否仍等于 `DELTA_THRESHOLD`"。是,就改断言;否,才是真回归。

### 2. 三个测试的存储断言无法参数化到 Azure 后端

`runtime.mf.getD1Database(...)` / `getR2Bucket(...)` 是 Miniflare 专有 API。设计第 7 节说"阶段 0 的测试套参数化后端,对 Azure 栈重跑",这句话对这几条断言目前只成立一半。

建议阶段 1 顺手把存储断言抽到一个后端可换的小 helper 后面(例如 `readSnapshotIndex(runtime, docId)`),别等到阶段 2 才发现要重写。

### 3. CAS 失败的判别依赖错误文案

`scripts/cas-rollback.test.mjs` 断言 `error` 包含 `CAS root-refs failed`。这不是洁癖 —— `#leaseFailure` 对未知错误**也返回 502**,单看状态码无法区分"lease 失败"和"root-refs 失败"。这条字符串是当前唯一的判别器。

阶段 1 如果给错误响应加了机器可读字段(例如 `stage: "root-refs"`),把断言换过去,别只是改文案。

### 4. 已知的既有问题,不由阶段 0 负责

`cloudflare-docx` / `cloudflare-markdown` / `cloudflare-gateway` 三个包没有测试文件,`vitest run` 因此 exit 1,使 `pnpm -r test` 整体非零退出。远端有一个未合并的 PR(`fix/workspace-test-no-test-files`,加 `--passWithNoTests`)专门修它。

因此本计划完成判据里的"`pnpm test` 全绿"在那个 PR 合并前无法勾上;`pnpm test:local` 是阶段 0 的有效判据。
