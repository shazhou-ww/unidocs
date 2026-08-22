/**
 * 阶段 2 在 session.ts 上做的五处行为变更，49 条 e2e 一条都打不到 ——
 * 它们要么需要直接篡改存储，要么需要在一个精确的时机注入失败。这里用
 * 内存端口包一层故障注入来钉住它们。
 *
 * 第五处(`#persistIdentity` 抛异常的 `errorResponse` 兜底)在
 * `packages/cloudflare-sdk/src/editor-do.ts`,不在 `session.ts` —— 它需要
 * 一个 Durable Object storage 层的故障注入,超出内存端口的表达范围。本文件
 * 不覆盖它,详见 spec `docs/superpowers/specs/2026-08-21-azure-phase3-design.md`
 * 第 11 节风险表。
 */
import { describe, expect, test } from "vitest";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { DocumentSession, type CasGateway, type SessionDeps } from "../src/session.js";
import { StorageCorruptError } from "../src/errors.js";
import { createMemoryPorts } from "../src/memory-ports.js";
import type { SnapshotCache } from "../src/ports.js";

const IDENTITY = { docType: "markdown", docId: "d1", userId: "u1" };
const encoder = new TextEncoder();

// Never exercised by these tests: create()/load()/query() only reach `cas`
// through DocumentTypeContext, and the markdown doctype never touches it
// (it has no CAS-backed refs — see doctype-markdown/src/markdown.ts). Kept
// minimal on purpose rather than shaped like a real gateway.
const CAS_STUB: CasGateway = {
  read: async () => {
    throw new Error("not used");
  },
  metadata: async () => {
    throw new Error("not used");
  },
  leaseExisting: async () => {
    throw new Error("not used");
  },
  updateRootRefs: async () => {
    throw new Error("not used");
  },
};

type MemoryPorts = ReturnType<typeof createMemoryPorts>;

// SessionDeps plus the one extra memory-port field (indexQuery) these tests
// read directly to assert on DocRecord rows.
type TestDeps = MemoryPorts & Pick<SessionDeps, "cas" | "identity" | "now">;

async function makeDeps(overrides: Partial<TestDeps> = {}): Promise<TestDeps> {
  const ports = createMemoryPorts();
  return {
    ...ports,
    cas: CAS_STUB,
    identity: IDENTITY,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function newSession(deps: TestDeps) {
  return new DocumentSession(createMarkdownDocumentType({}), deps);
}

describe("load() fallback paths", () => {
  // 快照缓存在 Cloudflare 上由 DO 自己的持久化存储支撑，每次写都刷新，
  // 正常生命周期里从不为空 —— 这条回退路径只有直接改存储才触发得到。
  test("falls back to the blob when the snapshot cache is empty", async () => {
    const deps = await makeDeps();
    const session = newSession(deps);
    await session.create({ bytes: encoder.encode("# original") });
    deps.snapshots.clear();

    const reloaded = newSession(deps);
    const result = await reloaded.query({ kind: "getContent" });
    expect(result.data).toBe("# original");
  });

  // b79bdf9 之前是 `if (bytes) {...}`，blob 缺失时静默透传到空文档重放，
  // 把数据丢失吞掉。现在是 fail-closed。没有任何测试锁住过这个翻转。
  test("a snapshot ref with no blob behind it throws StorageCorruptError", async () => {
    const deps = await makeDeps();
    const session = newSession(deps);
    await session.create({ bytes: encoder.encode("# original") });
    deps.snapshots.clear();
    deps.blobs.deleteAll();

    const reloaded = newSession(deps);
    await expect(reloaded.query({ kind: "getContent" })).rejects.toBeInstanceOf(
      StorageCorruptError,
    );
  });
});

describe("create() durability boundaries", () => {
  // a93a70f 之前快照缓存写失败会让已经落盘的创建报 500；现在异常被吞掉，
  // 创建返回成功，下次靠 blob 回退兜底。这个 500 -> 200 的翻转没被锁住。
  test("a failing snapshot-cache write does not fail the create", async () => {
    const ports = createMemoryPorts();
    // Delegate get()/clear() to the real cache and only fail put() — a
    // plain `{ ...ports.snapshots, put: ... }` spread would silently drop
    // get()/clear() too, since MemorySnapshotCache's methods live on its
    // prototype and a spread only copies own enumerable properties.
    const failingSnapshots: SnapshotCache & { clear(): void } = {
      get: () => ports.snapshots.get(),
      put: async () => {
        throw new Error("snapshot cache is down");
      },
      clear: () => ports.snapshots.clear(),
    };
    const deps = await makeDeps({ ...ports, snapshots: failingSnapshots });
    const session = newSession(deps);
    await expect(
      session.create({ bytes: encoder.encode("# survives") }),
    ).resolves.toMatchObject({ version: 1 });

    // Same durable ports (deltas/blobs/index) with a healthy snapshot cache
    // this time: this is the "next load falls back to the blob" leg of the
    // same behaviour, not a second, unrelated assertion.
    const reloaded = newSession(await makeDeps({ ...ports }));
    expect((await reloaded.query({ kind: "getContent" })).data).toBe("# survives");
  });

  // b7c153a 把 create() 的快照写改成直接 tx.index.recordSnapshot()，
  // createdAt/updatedAt 在同一次写里被设成同一个 timestamp。也就是说
  // 新建文档的 updatedAt === createdAt 现在是保证的行为，不是巧合。
  test("a freshly created document has updatedAt === createdAt", async () => {
    const deps = await makeDeps();
    await newSession(deps).create({ bytes: encoder.encode("# new") });
    const [row] = await deps.indexQuery.list("u1", "markdown");
    expect(row.updatedAt).toBe(row.createdAt);
  });
});
