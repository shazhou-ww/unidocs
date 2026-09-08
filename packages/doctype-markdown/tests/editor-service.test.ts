import { describe, expect, it } from "vitest";
import { sBlobSignature } from "@unidocs/protocol";
import type { Invocation, ServiceResult } from "@unidocs/protocol-doctype";
import { createChangeSet, createStateSource } from "@unidocs/protocol-doctype";
import { MarkdownEditorService } from "../src/index.js";
import type { MarkdownV1Operation } from "../src/index.js";

const invocation: Invocation = {
  requestId: "request-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  docId: "doc-1",
  docType: "markdown",
};
const base = { [sBlobSignature]: true as const, hash: "base-snapshot" };

describe("MarkdownEditorService", () => {
  it("rebuilds a fresh context from a base and ordered changes", async () => {
    const service = new MarkdownEditorService({
      loadSnapshot: async (blob) => {
        expect(blob).toEqual(base);
        return { content: "# Base" };
      },
      createContextId: () => "context-1",
    });
    const source = createStateSource<MarkdownV1Operation>("markdown/1", base, [
      createChangeSet([{ kind: "setContent", payload: { content: "# 第一版" } }]),
      createChangeSet([{ kind: "setContent", payload: { content: "# 第二版" } }]),
    ]);

    const initialized = expectSuccess(await service.init(invocation, source));
    expect(initialized).toEqual({ contextId: "context-1", sequence: 0 });
    expect(expectSuccess(await service.snapshot(invocation, initialized))).toEqual({
      content: "# 第二版",
    });
  });

  it("publishes apply atomically and advances the compute sequence once", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(
      invocation,
      createStateSource<MarkdownV1Operation>("markdown/1", null, []),
    ));
    const failed = await service.apply(invocation, context, createChangeSet<MarkdownV1Operation>([
      { kind: "appendSection", payload: { heading: "not-v1", content: "no" } },
    ] as never));

    expect(failed).toMatchObject({ success: false, error: { code: "operation_rejected" } });
    expect(expectSuccess(await service.snapshot(invocation, context))).toEqual({ content: "" });

    const applied = expectSuccess(await service.apply(invocation, context, createChangeSet([
      { kind: "setContent", payload: { content: "# 已保存" } },
    ])));
    expect(applied.sequence).toBe(1);
    expect(expectSuccess(await service.snapshot(invocation, applied))).toEqual({ content: "# 已保存" });
  });

  it("rejects stale sequences without changing the context", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(
      invocation,
      createStateSource<MarkdownV1Operation>("markdown/1", null, []),
    ));
    const applied = expectSuccess(await service.apply(invocation, context, createChangeSet([
      { kind: "setContent", payload: { content: "current" } },
    ])));

    await expect(service.apply(invocation, context, createChangeSet([
      { kind: "setContent", payload: { content: "stale" } },
    ]))).resolves.toMatchObject({ success: false, error: { code: "sequence_conflict" } });
    expect(expectSuccess(await service.snapshot(invocation, applied))).toEqual({ content: "current" });
  });

  it("accepts only one of two concurrent applies at the same sequence", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(
      invocation,
      createStateSource<MarkdownV1Operation>("markdown/1", null, []),
    ));
    const results = await Promise.all(["first", "second"].map((content) =>
      service.apply(invocation, context, createChangeSet<MarkdownV1Operation>([
        { kind: "setContent", payload: { content } },
      ])),
    ));

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results[1]).toMatchObject({ success: false, error: { code: "sequence_conflict" } });
    expect(expectSuccess(await service.snapshot(invocation, { ...context, sequence: 1 })))
      .toEqual({ content: "first" });
  });

  it("queues snapshots behind apply and captures caller-owned inputs", async () => {
    const service = createService();
    const context = { ...expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, []))) };
    const operation = { kind: "setContent" as const, payload: { content: "fixed" } };
    const requestInvocation = { ...invocation };
    const applied = service.apply(requestInvocation, context, createChangeSet([operation]));
    const snapshot = service.snapshot(invocation, { ...context, sequence: 1 });
    operation.payload.content = "mutated";
    requestInvocation.actorId = "other";
    context.sequence = 99;

    expectSuccess(await applied);
    expect(expectSuccess(await snapshot)).toEqual({ content: "fixed" });
  });

  it("does not poison the context queue after a failed request", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
    const conflict = service.apply(invocation, { ...context, sequence: 4 }, createChangeSet<MarkdownV1Operation>([]));
    const success = service.apply(invocation, context, createChangeSet<MarkdownV1Operation>([
      { kind: "setContent", payload: { content: "next" } },
    ]));
    expect(await conflict).toMatchObject({ success: false, error: { code: "sequence_conflict" } });
    expect(expectSuccess(await success).sequence).toBe(1);
  });

  it("expires contexts without extending their lifetime on reads or writes", async () => {
    let now = 0;
    const service = new MarkdownEditorService({ loadSnapshot: async () => ({}), now: () => now, contextTtlMs: 10 });
    const context = expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
    now = 9;
    expectSuccess(await service.snapshot(invocation, context));
    const applied = expectSuccess(await service.apply(invocation, context, createChangeSet<MarkdownV1Operation>([])));
    now = 10;
    expect(await service.snapshot(invocation, applied)).toMatchObject({ success: false, error: { code: "context_lost" } });
    expect(await service.apply(invocation, applied, createChangeSet<MarkdownV1Operation>([])))
      .toMatchObject({ success: false, error: { code: "context_lost" } });
  });

  it("reserves capacity during init and frees it after expiration", async () => {
    const loaded = Promise.withResolvers<unknown>();
    let now = 0;
    const service = new MarkdownEditorService({
      loadSnapshot: () => loaded.promise,
      now: () => now,
      contextTtlMs: 10,
      maxContexts: 1,
    });
    const pending = service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", base, []));
    expect(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])))
      .toMatchObject({ success: false, error: { code: "limit_exceeded" } });
    loaded.resolve({ content: "base" });
    const original = expectSuccess(await pending);
    now = 10;
    const replacement = expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
    expect(replacement.contextId).not.toBe(original.contextId);
  });

  it("captures the binding and changes before asynchronous base loading", async () => {
    const loaded = Promise.withResolvers<unknown>();
    const service = new MarkdownEditorService({ loadSnapshot: () => loaded.promise });
    const requestInvocation = { ...invocation };
    const operation = { kind: "setContent" as const, payload: { content: "fixed" } };
    const pending = service.init(requestInvocation, createStateSource<MarkdownV1Operation>("markdown/1", base, [createChangeSet([operation])]));
    operation.payload.content = "mutated";
    requestInvocation.tenantId = "other";
    loaded.resolve({ content: "base" });
    expect(expectSuccess(await service.snapshot(invocation, expectSuccess(await pending))))
      .toEqual({ content: "fixed" });
  });

  it("classifies resource failure without leaking details and releases capacity", async () => {
    const service = new MarkdownEditorService({
      loadSnapshot: async () => { throw new Error("Authorization: secret-token"); },
      maxContexts: 1,
    });
    const result = await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", base, []));
    expect(result).toEqual({ success: false, error: { code: "resource_unavailable", message: "Markdown snapshot is unavailable" } });
    expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
  });

  it("never overwrites an existing context when allocation collides", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
    expect(await service.init({ ...invocation, docId: "other" }, createStateSource<MarkdownV1Operation>("markdown/1", null, [])))
      .toMatchObject({ success: false, error: { code: "internal_error" } });
    expectSuccess(await service.snapshot(invocation, context));
  });

  it("reopens a saved snapshot in a new service instance without old contexts", async () => {
    const first = createService();
    const context = expectSuccess(await first.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [
      createChangeSet([{ kind: "setContent", payload: { content: "# 中文\n\n- saved" } }]),
    ])));
    const saved = expectSuccess(await first.snapshot(invocation, context));
    saved.content += "\n";
    expect(expectSuccess(await first.snapshot(invocation, context)).content).not.toBe(saved.content);
    const restarted = new MarkdownEditorService({ loadSnapshot: async () => saved });
    expect(await restarted.snapshot(invocation, context)).toMatchObject({ success: false, error: { code: "context_lost" } });
    const reopened = expectSuccess(await restarted.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", base, [])));
    expect(expectSuccess(await restarted.snapshot(invocation, reopened))).toEqual(saved);
  });

  it.each([
    null,
    { schemaVersion: "markdown/1", base: "hash", changes: [] },
    { schemaVersion: "markdown/1", base: null, changes: new Array(1) },
    { schemaVersion: "markdown/1", base: null, changes: [], token: "secret" },
  ])("rejects malformed sources without loading snapshots: %j", async (source) => {
    const service = new MarkdownEditorService({ loadSnapshot: async () => { throw new Error("must not load"); } });
    expect(await service.init(invocation, source as never)).toMatchObject({ success: false, error: { code: "invalid_request" } });
  });

  it.each([
    { operations: new Array(1) },
    { operations: [{ kind: "setContent", payload: { content: "text", token: "secret" } }] },
    { operations: [{ kind: "setContent", payload: { content: 42 } }] },
  ])("rejects malformed operations without advancing the sequence: %j", async (changes) => {
    const service = createService();
    const context = expectSuccess(await service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/1", null, [])));
    expect(await service.apply(invocation, context, changes as never)).toMatchObject({ success: false, error: { code: "operation_rejected" } });
    expect(expectSuccess(await service.snapshot(invocation, context))).toEqual({ content: "" });
  });

  it("binds contexts to the asserted actor, tenant, document, and type", async () => {
    const service = createService();
    const context = expectSuccess(await service.init(
      invocation,
      createStateSource<MarkdownV1Operation>("markdown/1", null, []),
    ));

    for (const changed of ["actorId", "tenantId", "docId", "docType"] as const) {
      const other = { ...invocation, [changed]: `other-${changed}` };
      expect(await service.snapshot(other, context)).toMatchObject({
        success: false,
        error: { code: "context_lost" },
      });
    }
  });

  it("rejects unsupported schemas before loading a base snapshot", async () => {
    let loaded = false;
    const service = new MarkdownEditorService({
      loadSnapshot: async () => {
        loaded = true;
        return { content: "base" };
      },
    });

    await expect(service.init(invocation, createStateSource<MarkdownV1Operation>("markdown/2", base, [])))
      .resolves.toMatchObject({ success: false, error: { code: "unsupported_schema" } });
    expect(loaded).toBe(false);
  });
});

function createService(): MarkdownEditorService {
  return new MarkdownEditorService({
    loadSnapshot: async () => ({ content: "unused" }),
    createContextId: () => "context-1",
  });
}

function expectSuccess<T>(result: ServiceResult<T>): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}
