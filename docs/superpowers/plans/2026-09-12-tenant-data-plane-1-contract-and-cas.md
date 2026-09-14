# Tenant 数据面 Plan 1：Platform 契约与 CAS 接入

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `@unidocs/protocol-platform` 补上运行时 schema 与 oRPC contract，并让 portal worker 第一次具备读取 UniCAS snapshot blob 与 retain 业务根的能力。

**Architecture:** `protocol-platform` 目前是纯类型包（`index.ts` 全部 `export type *`，依赖只有 `@unidocs/protocol`，无 tests 目录）。本 plan 给它加 Zod 4 + `@orpc/contract`，把 Agent submission 与 Operator webhook 的既有 interface 改写成运行时 schema，再用 `oc` 定义 contract。随后在 `cloudflare-portal` 建立 CAS 接入：Platform 签发带 `refDomain` 的 stack-authority capability，**只读回 blob 并 retain 业务根**，blob 内容由 Agent 直连写入。

**Tech Stack:** TypeScript 5.9、Zod ^4.4.3、`@orpc/contract` 1.15.0、Vitest ^3.2.7、Miniflare 4、`@unicas/tenant-client` + `@unicas/tenant-blob-client`、`@unidocs/service-auth`。

**Spec:** `docs/superpowers/specs/2026-09-12-tenant-data-plane-design.md`（§3.2、§4、§10、§14 第 1–2 步）

## Global Constraints

- 依赖版本与 `packages/protocol-tenant-portal/package.json` 保持一致：`zod` `^4.4.3`、`@orpc/contract` `1.15.0`、`vitest` `^3.2.7`、`typescript` `^5.9.0`、`@types/node` `^24.13.3`。
- Schema 风格照 `packages/protocol-tenant-portal/src/schemas.ts`：`.describe()` 写在每个字段、对象以 `.readonly()` 收尾、导出的资源 schema 带 `.meta({ id: "..." })`。
- **既有 interface 不得被改名或删除**，它们是 `index.ts` 的公开导出。除 `AgentSubmissionRequest.newSnapshot` 一处（见 Task 3）外，新 schema 必须与既有 interface 结构一致，并用 `expectTypeOf` 在测试里钉住。
- `packages/cloudflare-portal/wrangler.jsonc` 是部署契约。**不要修改它的 `compatibility_date`**，本地 runtime 自带 `COMPATIBILITY_DATE`。
- `wrangler dev` 在 `packages/cloudflare-portal` 内跑不起来（compatibility date 超前于 workerd 二进制）。验证一律用 `pnpm dev portal`。
- `stacks/` 与 `scripts/` 下只写 Node ESM `.mjs`，不写 TypeScript。`doc-types.mjs`、`services.mjs`、`sql-statements.mjs` **必须保持零依赖**（`services.mjs` 与 `sql-statements.mjs` 无任何 import，`doc-types.mjs` 只允许 `node:path`）。
- `CLAUDE.md` 是 local-only（在 `.git/info/exclude` 里，从未被跟踪）。**绝不编辑它、绝不 `git add` 它、绝不从会把它扫进去的目录执行 `git add -A`。**
- Commit message 用英文祈使句，说明原因。**不要 push，不要开 PR。**
- 每个 task 结束时 `pnpm --filter <改动的包> test` 与 `typecheck` 必须通过。
- Platform **不写** blob 内容，只读回与 retain / release。写入是 Agent 的职责（spec §3.2）。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `packages/protocol-platform/package.json` | 加 `zod`、`@orpc/contract` 依赖与 `test` script |
| `packages/protocol-platform/tsconfig.test.json` | **新建。** 照 `protocol-tenant-portal` 的同名文件，把 `tests` 纳入 typecheck |
| `packages/protocol-platform/src/schemas.ts` | **新建。** 共享原语 + Agent submission + Operator webhook 的全部 Zod schema |
| `packages/protocol-platform/src/contract.ts` | **新建。** `agentApiContract` 与 `operatorWebhookContract` |
| `packages/protocol-platform/src/agent.ts` | 修改：`newSnapshot: SValue` → `newSnapshotBlob: CasBlobRef` |
| `packages/protocol-platform/src/index.ts` | 修改：值导出 schema 与 contract（现在全是 `export type *`） |
| `packages/protocol-platform/tests/schemas.test.ts` | **新建。** schema 边界与类型一致性 |
| `packages/protocol-platform/tests/contract.test.ts` | **新建。** contract 路径、方法、错误映射 |
| `packages/cloudflare-portal/src/cas-capability.ts` | **新建。** Platform 的 stack-authority capability 签发 |
| `packages/cloudflare-portal/src/snapshot-store.ts` | **新建。** 读回 snapshot blob、retain / release 业务根 |
| `packages/cloudflare-portal/tests/cas-capability.test.ts` | **新建。** |
| `packages/cloudflare-portal/tests/snapshot-store.test.ts` | **新建。** |
| `stacks/unidocs-cloudflare/local/services.mjs` | 修改：portal 组件增加 CAS binding 声明 |
| `stacks/unidocs-cloudflare/local/runtime.mjs` | 修改：把 CAS origin 与 stack 凭据注入 portal worker |
| `tests/integration/cloudflare/portal-cas.test.mjs` | **新建。** 真 workerd 上的 blob 往返 |

---

### Task 1: protocol-platform 的包基建与共享原语 schema

**Files:**
- Modify: `packages/protocol-platform/package.json`
- Create: `packages/protocol-platform/tsconfig.test.json`
- Create: `packages/protocol-platform/src/schemas.ts`
- Test: `packages/protocol-platform/tests/schemas.test.ts`

**Interfaces:**
- Consumes: `packages/protocol-platform/src/common.ts` 已有的 `CasBlobRef`、`DocumentLocation`、`MessageContent` 等 interface。
- Produces: `IdSchema`、`IsoDateTimeSchema`、`VersionIdxSchema`、`CommentIdxSchema`、`DocumentContractIdxSchema`、`CasBlobRefSchema`、`DocumentLocationSchema`、`MessageContentSchema`，供 Task 2–4 使用。

- [ ] **Step 1: 加依赖与 test script**

编辑 `packages/protocol-platform/package.json`，把 `dependencies` 与 `devDependencies` 改成：

```json
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc -b && tsc -p tsconfig.test.json",
    "clean": "rimraf --glob dist \"*.tsbuildinfo\""
  },
  "dependencies": {
    "@orpc/contract": "1.15.0",
    "@unidocs/protocol": "workspace:*",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "typescript": "^5.9.0",
    "vitest": "^3.2.7"
  },
```

- [ ] **Step 2: 建 tsconfig.test.json**

创建 `packages/protocol-platform/tsconfig.test.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "noEmit": true,
    "rootDir": ".",
    "types": [
      "node"
    ]
  },
  "include": [
    "src",
    "tests"
  ]
}
```

- [ ] **Step 3: 安装依赖**

```bash
pnpm install
```

- [ ] **Step 4: 写失败的测试**

创建 `packages/protocol-platform/tests/schemas.test.ts`：

```ts
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CasBlobRef, DocumentLocation, MessageContent } from "../src/index.js";
import {
  CasBlobRefSchema,
  DocumentLocationSchema,
  MessageContentSchema,
  VersionIdxSchema,
} from "../src/schemas.js";

describe("shared primitives", () => {
  it("infers the same shape as the existing interfaces", () => {
    expectTypeOf<typeof CasBlobRefSchema._output>().toEqualTypeOf<CasBlobRef>();
    expectTypeOf<typeof DocumentLocationSchema._output>().toEqualTypeOf<DocumentLocation>();
    expectTypeOf<typeof MessageContentSchema._output>().toEqualTypeOf<MessageContent>();
  });

  it("rejects a negative record index", () => {
    expect(VersionIdxSchema.safeParse(-1).success).toBe(false);
    expect(VersionIdxSchema.safeParse(0).success).toBe(true);
  });

  it("requires a blob hash, size and content type", () => {
    expect(CasBlobRefSchema.safeParse({ blobHash: "h", size: 0, contentType: "text/plain" }).success).toBe(true);
    expect(CasBlobRefSchema.safeParse({ blobHash: "", size: 0, contentType: "text/plain" }).success).toBe(false);
    expect(CasBlobRefSchema.safeParse({ blobHash: "h", size: -1, contentType: "text/plain" }).success).toBe(false);
  });

  it("requires message content to carry text or rich content", () => {
    expect(MessageContentSchema.safeParse({ text: "hi", richContent: null, attachments: [] }).success).toBe(true);
    expect(MessageContentSchema.safeParse({ text: null, richContent: null, attachments: [] }).success).toBe(false);
    expect(MessageContentSchema.safeParse({ text: "", richContent: null, attachments: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: FAIL，报 `Cannot find module '../src/schemas.js'`。

- [ ] **Step 6: 实现 schemas.ts**

创建 `packages/protocol-platform/src/schemas.ts`：

```ts
/**
 * Runtime schemas for the Platform contracts. The interfaces in common.ts,
 * agent.ts and operator.ts stay the public type surface; these schemas give the
 * same shapes a runtime, which a plain TypeScript interface cannot do.
 */
import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IdSchema = NonEmptyStringSchema;
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const RecordIdxSchema = z.number().int().nonnegative();
export const DocumentContractIdxSchema = RecordIdxSchema
  .describe("Zero-based paired Document Contract revision.");
export const VersionIdxSchema = RecordIdxSchema
  .describe("Zero-based, document-scoped version record ID.");
export const CommentIdxSchema = RecordIdxSchema
  .describe("Zero-based, thread-scoped comment record ID.");
export const ReplyIdxSchema = RecordIdxSchema
  .describe("Zero-based, thread-scoped reply record ID.");

export const JsonValueSchema: z.ZodType<
  null | string | number | boolean | readonly unknown[] | { readonly [key: string]: unknown }
> = z.lazy(() => z.union([
  z.null(),
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(JsonValueSchema).readonly(),
  z.record(z.string(), JsonValueSchema),
])) as never;

export const CasBlobRefSchema = z.object({
  blobHash: NonEmptyStringSchema.describe("UniCAS blob root hash."),
  size: z.number().int().nonnegative().describe("Logical byte length of the complete blob."),
  contentType: NonEmptyStringSchema.describe("Media type of the complete logical blob."),
}).readonly().meta({ id: "CasBlobRef" });

export const DocumentLocationSchema = z.object({
  documentContractIdx: DocumentContractIdxSchema
    .describe("Paired contract revision whose location schema validates this payload."),
  locationType: NonEmptyStringSchema.describe("Document-type-specific location kind."),
  payload: JsonValueSchema.describe("Opaque location payload."),
}).readonly().meta({ id: "DocumentLocation" });

export const MessageContentSchema = z.object({
  text: z.string().nullable().describe("Plain-text message body, or null."),
  richContent: CasBlobRefSchema.nullable().describe("Rich message body stored in UniCAS, or null."),
  attachments: z.array(CasBlobRefSchema).readonly().describe("Attachments; they never replace the body."),
}).refine(
  ({ text, richContent }) => (text !== null && text.length > 0) || richContent !== null,
  { message: "At least one of text or richContent must be present" },
).readonly().meta({ id: "MessageContent" });
```

- [ ] **Step 7: 跑测试确认通过**

```bash
pnpm --filter @unidocs/protocol-platform test
pnpm --filter @unidocs/protocol-platform typecheck
```

Expected: PASS。

如果 `expectTypeOf` 因为 `readonly` 修饰不一致而失败，调整 schema（`.readonly()` 的位置）而不是放宽断言——断言正是本 task 的价值。

- [ ] **Step 8: Commit**

```bash
git add packages/protocol-platform/package.json packages/protocol-platform/tsconfig.test.json packages/protocol-platform/src/schemas.ts packages/protocol-platform/tests/schemas.test.ts pnpm-lock.yaml
git commit -m "feat(protocol-platform): give the shared wire primitives a runtime

The package was type-only, so a malformed payload reached business code
unchecked. Zod schemas mirror the existing interfaces and are pinned to them
with expectTypeOf, so the two cannot drift."
```

---

### Task 2: Agent submission 的请求 schema 与两条结构约束

**Files:**
- Modify: `packages/protocol-platform/src/agent.ts`
- Modify: `packages/protocol-platform/src/schemas.ts`
- Test: `packages/protocol-platform/tests/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `IdSchema`、`VersionIdxSchema`、`CommentIdxSchema`、`DocumentContractIdxSchema`、`CasBlobRefSchema`、`DocumentLocationSchema`、`MessageContentSchema`。
- Produces: `AgentThreadUpdateSchema`、`AgentSubmissionRequestSchema`，以及被修改的 `AgentSubmissionRequest` interface（`newSnapshot` → `newSnapshotBlob`）。

**Background（实施者必读）：** 现有 `AgentSubmissionRequest.newSnapshot?: SValue` 无法作为 JSON 传输——`packages/svalue-codec/src/json.ts` 的 `toJsonValue` 遇到 SBlob 直接抛 `"SBlob cannot be represented as JSON"`。按 spec §3.2，snapshot 由 Agent 直连写入 UniCAS，submission 只携带引用。

- [ ] **Step 1: 写失败的测试**

把以下内容追加到 `packages/protocol-platform/tests/schemas.test.ts`：

```ts
import { AgentSubmissionRequestSchema } from "../src/schemas.js";

const blob = { blobHash: "h", size: 12, contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1" };
const content = { text: "done", richContent: null, attachments: [] };
const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 0, end: 1, quote: "x" } };

const threadUpdate = (over = {}) => ({
  threadId: "th-1",
  observedAcknowledgedCommentIdx: null,
  respondThroughCommentIdx: 0,
  content,
  resultLocations: [],
  ...over,
});

describe("AgentSubmissionRequestSchema", () => {
  it("accepts a pure reply with no snapshot and no current-version lock", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      threadUpdates: [threadUpdate()],
    });
    expect(result.success).toBe(true);
  });

  it("rejects result locations without a new snapshot blob", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      threadUpdates: [threadUpdate({ resultLocations: [location] })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a new snapshot blob without an observed current version", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [threadUpdate()],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a snapshot submission carrying both locks", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      observedCurrentVersionIdx: 3,
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [threadUpdate({ resultLocations: [location] })],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null observed current version on the first version", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      observedCurrentVersionIdx: null,
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: FAIL，`AgentSubmissionRequestSchema` 未导出。

- [ ] **Step 3: 改 agent.ts 的字段**

编辑 `packages/protocol-platform/src/agent.ts`：把 `AgentSubmissionRequest` 里的

```ts
  readonly newSnapshot?: SValue;
```

替换为

```ts
  /**
   * Snapshot written directly to UniCAS by the Agent before submitting. The
   * Platform does not proxy CAS node traffic; it reads this blob back to
   * validate it against the paired Document Contract revision, then retains
   * the blob root after the transaction commits.
   */
  readonly newSnapshotBlob?: CasBlobRef;
```

同一文件顶部的 import 相应调整：删掉 `import type { SValue } from "@unidocs/protocol";`（若该文件再无其他 SValue 用法），并把 `CasBlobRef` 加进从 `./common.js` 的类型导入清单。

- [ ] **Step 4: 实现 schema**

追加到 `packages/protocol-platform/src/schemas.ts`：

```ts
export const AgentThreadUpdateSchema = z.object({
  threadId: IdSchema.describe("Thread this update answers."),
  observedAcknowledgedCommentIdx: CommentIdxSchema.nullable()
    .describe("Thread lock: the acknowledgement watermark observed when the Agent froze its work."),
  respondThroughCommentIdx: CommentIdxSchema
    .describe("Cumulative acknowledgement watermark this reply advances the thread to."),
  content: MessageContentSchema.describe("Agent reply body."),
  resultLocations: z.array(DocumentLocationSchema).readonly()
    .describe("Locations in the version created by this same submission; empty for a pure reply."),
}).readonly().meta({ id: "AgentThreadUpdate" });

/**
 * The two structural rules come from
 * docs/design/platform-v0/agent-mediated-document-collaboration.md §7.1 and
 * cannot be expressed by the optional fields alone.
 */
export const AgentSubmissionRequestSchema = z.object({
  submissionId: IdSchema.describe("Caller-assigned idempotency identity for this submission."),
  observedCurrentVersionIdx: VersionIdxSchema.nullable().optional()
    .describe("Version lock: the current pointer observed at commit. Null means the document had no version."),
  newDocumentContractIdx: DocumentContractIdxSchema.optional()
    .describe("Paired revision validating newSnapshotBlob; required alongside it."),
  newSnapshotBlob: CasBlobRefSchema.optional()
    .describe("Snapshot the Agent already wrote to UniCAS, referenced rather than inlined."),
  threadUpdates: z.array(AgentThreadUpdateSchema).readonly()
    .describe("Replies to commit atomically with the optional new version."),
}).superRefine((request, context) => {
  const hasSnapshot = request.newSnapshotBlob !== undefined;
  if (request.threadUpdates.some(update => update.resultLocations.length > 0) && !hasSnapshot) {
    context.addIssue({
      code: "custom",
      path: ["threadUpdates"],
      message: "resultLocations are relative to a new version, so newSnapshotBlob is required",
    });
  }
  if (hasSnapshot && request.observedCurrentVersionIdx === undefined) {
    context.addIssue({
      code: "custom",
      path: ["observedCurrentVersionIdx"],
      message: "Creating a version requires the observed current pointer as an equality lock",
    });
  }
  if (hasSnapshot && request.newDocumentContractIdx === undefined) {
    context.addIssue({
      code: "custom",
      path: ["newDocumentContractIdx"],
      message: "A new snapshot must name the paired contract revision that validates it",
    });
  }
}).readonly().meta({ id: "AgentSubmissionRequest" });
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @unidocs/protocol-platform test
pnpm -r typecheck
```

Expected: PASS。`pnpm -r typecheck` 用来确认改 `agent.ts` 没有打破任何既有 import。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol-platform/src/agent.ts packages/protocol-platform/src/schemas.ts packages/protocol-platform/tests/schemas.test.ts
git commit -m "feat(protocol-platform): reference the snapshot blob instead of inlining SValue

SValue has no JSON representation - toJsonValue throws on an SBlob - so a
submission carrying newSnapshot could never be a JSON body. The Agent writes
the snapshot to UniCAS directly and submits a CasBlobRef, which also matches
the rule that the Platform never proxies CAS node traffic.

The two structural rules from the design doc's 7.1 become superRefine checks:
result locations require a new snapshot, and a new snapshot requires the
observed current pointer."
```

---

### Task 3: Submission 收据与冲突 schema

**Files:**
- Modify: `packages/protocol-platform/src/schemas.ts`
- Test: `packages/protocol-platform/tests/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 2 的 schema。
- Produces: `SubmissionConflictSchema`、`SubmissionReceiptSchema`、`VersionRecordSchema`、`ReplyRecordSchema`。

**Background：** 被拒绝的 submission **不是 HTTP 错误**。`AgentEndpointContracts.createSubmission` 的响应类型就是 `SubmissionReceipt`，而它是 `committed | rejected` 的可辨识联合，所以拒绝是一次 2xx 响应，携带 `SubmissionConflict` 供 Agent 重算。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/protocol-platform/tests/schemas.test.ts`：

```ts
import { SubmissionReceiptSchema } from "../src/schemas.js";

describe("SubmissionReceiptSchema", () => {
  it("accepts a committed receipt with a version and replies", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "committed",
      version: {
        versionIdx: 1,
        parentVersionIdx: 0,
        documentContractIdx: 0,
        authorAgentId: "agent:operator-markdown",
        submissionId: "sub-1",
        addressedComments: [{ threadId: "th-1", commentIdx: 0, baseVersionIdx: 0 }],
        createdAt: "2026-09-12T00:00:00.000Z",
      },
      replies: [],
      committedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a committed pure reply whose version is null", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "committed",
      version: null,
      replies: [],
      committedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a rejected receipt carrying the conflict", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "rejected",
      reason: "version_conflict",
      conflict: {
        currentVersionIdx: 4,
        availableDocumentContractIdxs: [0],
        threads: [{ threadId: "th-1", acknowledgedCommentIdx: 1, latestCommentIdx: 2 }],
      },
      rejectedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown rejection reason", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "rejected",
      reason: "made_up",
      conflict: { currentVersionIdx: null, availableDocumentContractIdxs: [0], threads: [] },
      rejectedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: FAIL，`SubmissionReceiptSchema` 未导出。

- [ ] **Step 3: 实现 schema**

追加到 `packages/protocol-platform/src/schemas.ts`：

```ts
export const AddressedCommentSchema = z.object({
  threadId: IdSchema.describe("Thread containing the addressed comment."),
  commentIdx: CommentIdxSchema.describe("Addressed comment within that thread."),
  baseVersionIdx: VersionIdxSchema.describe("Version the addressed comment was written against."),
}).readonly().meta({ id: "AddressedComment" });

export const VersionRecordSchema = z.object({
  versionIdx: VersionIdxSchema.describe("Version identity and birth order."),
  parentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer observed at commit; null only for the first version."),
  documentContractIdx: DocumentContractIdxSchema.describe("Paired revision validating this snapshot."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that committed this version."),
  submissionId: IdSchema.describe("Submission that created this version."),
  addressedComments: z.array(AddressedCommentSchema).readonly()
    .describe("Comment provenance; empty for the first version."),
  createdAt: IsoDateTimeSchema.describe("Time at which the version was committed."),
}).readonly().meta({ id: "VersionRecord" });

export const ReplyRecordSchema = z.object({
  replyIdx: ReplyIdxSchema.describe("Reply identity within its thread."),
  respondThroughCommentIdx: CommentIdxSchema
    .describe("Cumulative acknowledgement watermark this reply advanced the thread to."),
  content: MessageContentSchema.describe("Agent message body."),
  resultLocations: z.array(DocumentLocationSchema).readonly()
    .describe("Locations in the version created by the same submission."),
  authorAgentId: NonEmptyStringSchema.describe("Agent identity that produced the reply."),
  submissionId: IdSchema.describe("Submission that committed this reply."),
  createdAt: IsoDateTimeSchema.describe("Time at which the reply was committed."),
}).readonly().meta({ id: "ReplyRecord" });

export const SubmissionConflictSchema = z.object({
  currentVersionIdx: VersionIdxSchema.nullable().describe("Current pointer at the time of rejection."),
  availableDocumentContractIdxs: z.array(DocumentContractIdxSchema).readonly()
    .describe("Revisions currently writable for this document type."),
  threads: z.array(z.object({
    threadId: IdSchema,
    acknowledgedCommentIdx: CommentIdxSchema.nullable(),
    latestCommentIdx: CommentIdxSchema,
  }).readonly()).readonly().describe("Present watermarks for the threads the submission addressed."),
}).readonly().meta({ id: "SubmissionConflict" });

export const SubmissionRejectionReasonSchema = z.enum([
  "version_conflict",
  "document_contract_conflict",
  "reply_watermark_conflict",
]);

/**
 * A rejected submission is a successful HTTP response, not a 4xx: the endpoint's
 * response type is this union, and the Agent recomputes from `conflict`.
 */
export const SubmissionReceiptSchema = z.discriminatedUnion("state", [
  z.object({
    submissionId: IdSchema,
    state: z.literal("committed"),
    version: VersionRecordSchema.nullable().describe("Null for a pure reply."),
    replies: z.array(ReplyRecordSchema).readonly(),
    committedAt: IsoDateTimeSchema,
  }).readonly(),
  z.object({
    submissionId: IdSchema,
    state: z.literal("rejected"),
    reason: SubmissionRejectionReasonSchema,
    conflict: SubmissionConflictSchema,
    rejectedAt: IsoDateTimeSchema,
  }).readonly(),
]).meta({ id: "SubmissionReceipt" });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/protocol-platform test
pnpm --filter @unidocs/protocol-platform typecheck
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol-platform/src/schemas.ts packages/protocol-platform/tests/schemas.test.ts
git commit -m "feat(protocol-platform): give submission receipts a runtime schema

A rejected submission is a 2xx response carrying the conflict, not an error
status, so the receipt union needs to validate both branches. The test pins
that an unknown rejection reason is refused."
```

---

### Task 4: Operator webhook schema

**Files:**
- Modify: `packages/protocol-platform/src/schemas.ts`
- Test: `packages/protocol-platform/tests/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 的 schema。
- Produces: `OperatorWebhookRequestSchema`、`OperatorWebhookResponseSchema`。

- [ ] **Step 1: 写失败的测试**

追加到 `packages/protocol-platform/tests/schemas.test.ts`：

```ts
import { OperatorWebhookRequestSchema } from "../src/schemas.js";

const webhook = (over = {}) => ({
  protocol: "unidocs-operator-webhook/v1",
  eventId: "evt-1",
  reason: "comment.appended",
  tenantId: "t-local",
  documentId: "doc-1",
  documentType: "markdown",
  currentVersionIdx: 0,
  newComments: [{ threadId: "th-1", commentIdx: 1, acknowledgedCommentIdx: 0 }],
  occurredAt: "2026-09-12T00:00:00.000Z",
  ...over,
});

describe("OperatorWebhookRequestSchema", () => {
  it("accepts an incremental comment notification", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook()).success).toBe(true);
  });

  it("accepts a document.created notification with no current version", () => {
    const result = OperatorWebhookRequestSchema.safeParse(
      webhook({ reason: "document.created", currentVersionIdx: null, newComments: [] }),
    );
    expect(result.success).toBe(true);
  });

  it("refuses a wrong protocol literal", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook({ protocol: "v2" })).success).toBe(false);
  });

  it("refuses an unknown reason", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook({ reason: "document.deleted" })).success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: FAIL，`OperatorWebhookRequestSchema` 未导出。

- [ ] **Step 3: 实现 schema**

追加到 `packages/protocol-platform/src/schemas.ts`：

```ts
export const OperatorEventReasonSchema = z.enum([
  "document.created",
  "comment.appended",
  "current_version.moved",
]);

/** Delivery is at-least-once, and acceptance does not imply the Agent finished. */
export const OperatorWebhookRequestSchema = z.object({
  protocol: z.literal("unidocs-operator-webhook/v1"),
  eventId: IdSchema.describe("Stable event identity for duplicate suppression."),
  reason: OperatorEventReasonSchema,
  tenantId: IdSchema,
  documentId: IdSchema,
  documentType: NonEmptyStringSchema,
  currentVersionIdx: VersionIdxSchema.nullable()
    .describe("Current pointer at the time of the event; null before the first version."),
  newComments: z.array(z.object({
    threadId: IdSchema,
    commentIdx: CommentIdxSchema,
    acknowledgedCommentIdx: CommentIdxSchema.nullable(),
  }).readonly()).readonly().describe("Work hint, not a transaction boundary."),
  occurredAt: IsoDateTimeSchema,
}).readonly().meta({ id: "OperatorWebhookRequest" });

export const OperatorWebhookResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: IdSchema,
}).readonly().meta({ id: "OperatorWebhookResponse" });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol-platform/src/schemas.ts packages/protocol-platform/tests/schemas.test.ts
git commit -m "feat(protocol-platform): validate the Operator webhook payload

The protocol literal and the closed reason set are the two things a malformed
or downgraded caller gets wrong, so both are pinned by tests."
```

---

### Task 5: Agent 与 Operator 的 oRPC contract

**Files:**
- Create: `packages/protocol-platform/src/contract.ts`
- Modify: `packages/protocol-platform/src/index.ts`
- Test: `packages/protocol-platform/tests/contract.test.ts`

**Interfaces:**
- Consumes: Task 2–4 的全部 schema。
- Produces: `agentApiContract`（`submissions.create`、`submissions.get`）、`operatorWebhookContract`（`notifyDocument`）、`AgentApiV1BasePath`，供 Plan 3 的 submissions 端点与 Operator worker 使用。

- [ ] **Step 1: 写失败的测试**

创建 `packages/protocol-platform/tests/contract.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { agentApiContract, AgentApiV1BasePath, operatorWebhookContract } from "../src/contract.js";

describe("agentApiContract", () => {
  it("posts submissions under the tenant-scoped document path", () => {
    const route = agentApiContract.submissions.create["~orpc"].route;
    expect(route.method).toBe("POST");
    expect(route.path).toBe(`${AgentApiV1BasePath}/documents/{documentId}/submissions`);
    expect(route.successStatus).toBe(201);
  });

  it("reads a receipt back by submission id", () => {
    const route = agentApiContract.submissions.get["~orpc"].route;
    expect(route.method).toBe("GET");
    expect(route.path).toBe(`${AgentApiV1BasePath}/documents/{documentId}/submissions/{submissionId}`);
  });

  it("keeps the tenant path shape aligned with the tenant API", () => {
    expect(AgentApiV1BasePath).toBe("/api/v1/tenants/{tenantId}");
  });
});

describe("operatorWebhookContract", () => {
  it("notifies one document at a time", () => {
    const route = operatorWebhookContract.notifyDocument["~orpc"].route;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/tenants/{tenantId}/documents/{documentId}");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/protocol-platform test
```

Expected: FAIL，`../src/contract.js` 不存在。

- [ ] **Step 3: 实现 contract**

创建 `packages/protocol-platform/src/contract.ts`：

```ts
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AgentSubmissionRequestSchema,
  IdSchema,
  OperatorWebhookRequestSchema,
  OperatorWebhookResponseSchema,
  SubmissionReceiptSchema,
} from "./schemas.js";

/** Identical to the tenant API base path: an Agent addresses the same resources. */
export const AgentApiV1BasePath = "/api/v1/tenants/{tenantId}";

const ErrorDataSchema = z.object({
  requestId: IdSchema,
}).readonly();

const agentProcedure = oc.errors({
  INVALID_REQUEST: { status: 400, message: "The request is invalid", data: ErrorDataSchema },
  UNAUTHORIZED: { status: 401, message: "Agent authentication is required", data: ErrorDataSchema },
  FORBIDDEN: { status: 403, message: "The Agent is not allowed to perform this operation", data: ErrorDataSchema },
  NOT_FOUND: { status: 404, message: "The requested resource was not found", data: ErrorDataSchema },
  UNAVAILABLE: { status: 503, message: "The Platform is temporarily unavailable", data: ErrorDataSchema },
});

const documentParams = z.object({
  tenantId: IdSchema.describe("Tenant that owns the document."),
  documentId: IdSchema.describe("Document being submitted against."),
}).readonly();

const submissionParams = z.object({
  tenantId: IdSchema,
  documentId: IdSchema,
  submissionId: IdSchema.describe("Submission whose durable receipt is being read."),
}).readonly();

export const createSubmissionContract = agentProcedure
  .errors({
    CONTENT_UNAVAILABLE: { status: 409, message: "The referenced snapshot blob is not readable", data: ErrorDataSchema },
    LOCATION_CONTRACT_VIOLATION: { status: 422, message: "A location does not satisfy its Document Contract location schema", data: ErrorDataSchema },
  })
  .route({
    method: "POST",
    path: `${AgentApiV1BasePath}/documents/{documentId}/submissions`,
    operationId: "createSubmission",
    summary: "Atomically create a version and append replies",
    description: "Validates both optimistic locks, optionally creates a version from a snapshot the Agent already wrote to UniCAS, appends every reply, advances the addressed thread watermarks, and persists a durable receipt. A lock failure is NOT an error status: the response is a rejected receipt carrying the current conflict, because the Agent recomputes from it and resubmits.",
    inputStructure: "detailed",
    successStatus: 201,
    tags: ["Submissions"],
  })
  .input(z.object({
    params: documentParams,
    body: AgentSubmissionRequestSchema,
  }).readonly())
  .output(SubmissionReceiptSchema);

export const getSubmissionContract = agentProcedure
  .route({
    method: "GET",
    path: `${AgentApiV1BasePath}/documents/{documentId}/submissions/{submissionId}`,
    operationId: "getSubmission",
    summary: "Read a durable submission receipt",
    description: "Recovers the receipt after a timeout or retry without repeating the work.",
    inputStructure: "detailed",
    tags: ["Submissions"],
  })
  .input(z.object({ params: submissionParams }).readonly())
  .output(SubmissionReceiptSchema);

export const notifyDocumentContract = oc
  .route({
    method: "POST",
    path: "/tenants/{tenantId}/documents/{documentId}",
    operationId: "notifyDocument",
    summary: "Deliver an incremental Operator work notification",
    description: "At-least-once delivery. Acceptance does not imply the corresponding Agent work has completed; the payload is a work hint, not a transaction boundary.",
    inputStructure: "detailed",
    tags: ["Operator"],
  })
  .input(z.object({
    params: z.object({ tenantId: IdSchema, documentId: IdSchema }).readonly(),
    body: OperatorWebhookRequestSchema,
  }).readonly())
  .output(OperatorWebhookResponseSchema);

export const agentApiContract = {
  submissions: {
    create: createSubmissionContract,
    get: getSubmissionContract,
  },
};

export const operatorWebhookContract = {
  notifyDocument: notifyDocumentContract,
};

export type AgentApiContract = typeof agentApiContract;
export type OperatorWebhookContract = typeof operatorWebhookContract;
```

- [ ] **Step 4: 从 index.ts 导出**

编辑 `packages/protocol-platform/src/index.ts`，在现有 `export type *` 之后追加值导出：

```ts
export * from "./schemas.js";
export {
  agentApiContract,
  AgentApiV1BasePath,
  createSubmissionContract,
  getSubmissionContract,
  notifyDocumentContract,
  operatorWebhookContract,
} from "./contract.js";
export type { AgentApiContract, OperatorWebhookContract } from "./contract.js";
```

注意文件头的注释说这是 "Public type-only entrypoint"，把它改成不再声称 type-only：

```ts
/**
 * Public entrypoint for every @unidocs/protocol-platform contract: the type
 * surface, the runtime schemas that mirror it, and the oRPC contracts.
 */
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @unidocs/protocol-platform test
pnpm -r typecheck
```

Expected: PASS。若 `["~orpc"].route` 的内部属性访问在当前 `@orpc/contract` 版本上不成立，改用该版本暴露的公开方式读取 route 元数据，但**断言的内容不变**（方法、路径、successStatus）。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol-platform/src/contract.ts packages/protocol-platform/src/index.ts packages/protocol-platform/tests/contract.test.ts
git commit -m "feat(protocol-platform): define the Agent and Operator contracts with oRPC

Routing and input validation for the submissions endpoint now come from the
contract the way the tenant and admin APIs already do, instead of being hand
written at the adapter. The submissions output is the whole receipt union, so
a rejected submission stays a 2xx response."
```

---

### Task 6: Platform 的 stack-authority CAS capability

**Files:**
- Create: `packages/cloudflare-portal/src/cas-capability.ts`
- Test: `packages/cloudflare-portal/tests/cas-capability.test.ts`

**Interfaces:**
- Consumes: `@unidocs/service-auth` 的 `CapabilityIssuer`、`casReadPermission`、`CapabilityAlgorithm`。
- Produces: `createPlatformCasCapability(config): () => Promise<string>`，供 Task 7 的 snapshot store 作为 `getToken` 使用。

**Background：** Platform 是 stack authority，所以它的 capability 携带 `refDomain`——`IssueCapabilityInput.refDomain` 的注释写明「only stack-authority capabilities that write root references carry it」。Agent 的 capability 不带 `refDomain`，因此写得了节点但动不了业务根。

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/cas-capability.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createPlatformCasCapability } from "../src/cas-capability.js";

function issuerDouble() {
  const issue = vi.fn(async () => "token-1");
  return { issue, issuer: { issue } as unknown as Parameters<typeof createPlatformCasCapability>[0]["issuer"] };
}

describe("createPlatformCasCapability", () => {
  it("requests a read capability carrying the stack ref domain", async () => {
    const { issue, issuer } = issuerDouble();
    const getToken = createPlatformCasCapability({
      issuer,
      tenantId: "t-local",
      audience: "unidocs-cas-stack:local",
      subject: "platform:portal",
      refDomain: "doc",
    });

    await expect(getToken()).resolves.toBe("token-1");
    expect(issue).toHaveBeenCalledTimes(1);
    const input = issue.mock.calls[0][0];
    expect(input.tenantId).toBe("t-local");
    expect(input.refDomain).toBe("doc");
    expect(input.permissions).toContain("cas:read:t-local");
  });

  it("never carries a session id, because this is not a user credential", async () => {
    const { issue, issuer } = issuerDouble();
    await createPlatformCasCapability({
      issuer, tenantId: "t-local", audience: "a", subject: "platform:portal", refDomain: "d",
    })();
    expect(issue.mock.calls[0][0].sessionId).toBeUndefined();
  });

  it("refuses to build without a ref domain", () => {
    const { issuer } = issuerDouble();
    expect(() => createPlatformCasCapability({
      issuer, tenantId: "t-local", audience: "a", subject: "platform:portal", refDomain: "",
    })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- cas-capability
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/cas-capability.ts`：

```ts
/**
 * The Platform's own CAS credential.
 *
 * It is deliberately narrower than it looks: the Platform never writes blob
 * content - an Agent does that directly, because the tenant contract states
 * the Platform does not proxy CAS node traffic. What the Platform alone can do
 * is move business root references, which is why this capability carries a
 * refDomain and an Agent's does not.
 */
import { casReadPermission, type CapabilityIssuer } from "@unidocs/service-auth";

export interface PlatformCasCapabilityConfig {
  readonly issuer: CapabilityIssuer;
  readonly tenantId: string;
  readonly audience: string;
  readonly subject: string;
  /** Stable Root Refs domain; only stack-authority capabilities carry one. */
  readonly refDomain: string;
  readonly lifetimeSeconds?: number;
}

export function createPlatformCasCapability(
  config: PlatformCasCapabilityConfig,
): () => Promise<string> {
  if (!config.refDomain) {
    throw new TypeError("A Platform CAS capability must carry a Root Refs domain");
  }
  if (!config.tenantId || !config.audience || !config.subject) {
    throw new TypeError("A Platform CAS capability needs a tenant, audience and subject");
  }
  return async () => config.issuer.issue({
    subject: config.subject,
    audience: config.audience,
    tenantId: config.tenantId,
    permissions: [casReadPermission(config.tenantId)],
    refDomain: config.refDomain,
    ...(config.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: config.lifetimeSeconds }),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- cas-capability
```

Expected: PASS。

若 `casReadPermission("t-local")` 的实际返回串与测试里的 `"cas:read:t-local"` 不一致，**改测试去匹配真实实现**（用 `expect(input.permissions).toContain(casReadPermission("t-local"))`），不要改实现去迁就字面量。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/cas-capability.ts packages/cloudflare-portal/tests/cas-capability.test.ts
git commit -m "feat(portal): issue the Platform's own CAS capability

Scoped to reads plus root-reference authority: blob content is written by the
Agent directly, and only a stack-authority capability carries a refDomain, so
the Platform keeps the last say over what the collector may reclaim."
```

---

### Task 7: Snapshot blob 的读回与业务根保留

**Files:**
- Create: `packages/cloudflare-portal/src/snapshot-store.ts`
- Test: `packages/cloudflare-portal/tests/snapshot-store.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `createPlatformCasCapability`；`@unicas/tenant-blob-client` 的 `createCasBlobClient`、`CasBlobClient`。
- Produces: `createSnapshotStore(blobClient): SnapshotStore`，含 `read(ref)`、`retain(ref, requestId)`、`release(ref, requestId)`，供 Plan 2 的 `TenantVersionRepository` 与 Plan 3 的 submissions 端点使用。

**Background：** 两处字段名不同，必须映射——`@unicas/tenant-blob-client` 的 `CasBlobRef` 是 `{ hash, size, contentType }`，Platform 契约的 `CasBlobRef` 是 `{ blobHash, size, contentType }`。

`CasBlobClient` 的相关方法签名：

```ts
openBlob(hash: CasHash, signal?: AbortSignal): Promise<CasBlobHandle>;
retain(update: { requestId: string; references: Readonly<Record<string, number>> }): Promise<CasRootRefsResult>;
release(update: { requestId: string; references: Readonly<Record<string, number>> }): Promise<CasRootRefsResult>;
// CasBlobHandle.read(range?, signal?): ReadableStream<Uint8Array>
```

- [ ] **Step 1: 写失败的测试**

创建 `packages/cloudflare-portal/tests/snapshot-store.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { createSnapshotStore } from "../src/snapshot-store.js";

const ref = { blobHash: "abc", size: 3, contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1" };

function blobClientDouble() {
  const read = vi.fn(() => new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
  }));
  const openBlob = vi.fn(async () => ({ ref: { hash: "abc", size: 3, contentType: ref.contentType }, read, readBytes: vi.fn() }));
  const retain = vi.fn(async () => ({}));
  const release = vi.fn(async () => ({}));
  return { openBlob, retain, release, read, client: { openBlob, retain, release } as never };
}

describe("snapshot store", () => {
  it("opens the blob by its contract-side hash field", async () => {
    const double = blobClientDouble();
    const store = createSnapshotStore(double.client);
    const stream = await store.read(ref);
    expect(double.openBlob).toHaveBeenCalledWith("abc", undefined);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    expect(chunks[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("retains one root reference per blob", async () => {
    const double = blobClientDouble();
    await createSnapshotStore(double.client).retain(ref, "req-1");
    expect(double.retain).toHaveBeenCalledWith({ requestId: "req-1", references: { abc: 1 } });
  });

  it("releases with the same shape, so archival can reuse it", async () => {
    const double = blobClientDouble();
    await createSnapshotStore(double.client).release(ref, "req-2");
    expect(double.release).toHaveBeenCalledWith({ requestId: "req-2", references: { abc: 1 } });
  });

  it("refuses a reference whose declared size disagrees with the stored blob", async () => {
    const double = blobClientDouble();
    const store = createSnapshotStore(double.client);
    await expect(store.read({ ...ref, size: 99 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- snapshot-store
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `packages/cloudflare-portal/src/snapshot-store.ts`：

```ts
/**
 * Snapshot bytes live in UniCAS; D1 keeps only the reference.
 *
 * The Platform reads and retains, it does not write: an Agent writes the blob
 * directly and every node it writes is leased, which is temporary. Retaining
 * converts that lease into a business root reference and must happen AFTER the
 * surrounding D1 transaction commits, or a rejected submission would leave a
 * permanently rooted blob behind.
 */
import type { CasBlobClient } from "@unicas/tenant-blob-client";
import type { CasBlobRef } from "@unidocs/protocol-platform";

export interface SnapshotStore {
  /**
   * Returns the raw canonical SValue CBOR. Validating it against the paired
   * Document Contract's snapshot schema is the submissions endpoint's job
   * (Plan 3), not this module's: the schema is a per-version fact this store
   * has no access to.
   */
  read(ref: CasBlobRef, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  retain(ref: CasBlobRef, requestId: string): Promise<void>;
  release(ref: CasBlobRef, requestId: string): Promise<void>;
}

/**
 * The blob client names the digest `hash`; the Platform contract names it
 * `blobHash`. One mapping, in one place.
 */
function toBlobHash(ref: CasBlobRef): string {
  if (!ref.blobHash) throw new TypeError("A snapshot reference needs a blob hash");
  return ref.blobHash;
}

export function createSnapshotStore(client: CasBlobClient): SnapshotStore {
  return {
    async read(ref, signal) {
      const handle = await client.openBlob(toBlobHash(ref), signal);
      if (handle.ref.size !== ref.size) {
        throw new Error(
          `Snapshot blob ${ref.blobHash} is ${handle.ref.size} bytes, but the version record declares ${ref.size}`,
        );
      }
      return handle.read(undefined, signal);
    },

    async retain(ref, requestId) {
      await client.retain({ requestId, references: { [toBlobHash(ref)]: 1 } });
    },

    async release(ref, requestId) {
      await client.release({ requestId, references: { [toBlobHash(ref)]: 1 } });
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @unidocs/cloudflare-portal test -- snapshot-store
pnpm --filter @unidocs/cloudflare-portal typecheck
```

Expected: PASS。

若 `@unicas/tenant-blob-client` 尚未在 `packages/cloudflare-portal/package.json` 的 dependencies 里，加上 `"@unicas/tenant-blob-client": "workspace:*"` 与 `"@unicas/tenant-client": "workspace:*"`，然后 `pnpm install`，并把 `package.json` 与 `pnpm-lock.yaml` 一并提交。

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-portal/src/snapshot-store.ts packages/cloudflare-portal/tests/snapshot-store.test.ts packages/cloudflare-portal/package.json pnpm-lock.yaml
git commit -m "feat(portal): read snapshot blobs and retain their business roots

Retain is separate from the write on purpose: the Agent's write only leases
the nodes, and promoting that lease to a root must wait until the submission's
transaction has committed. Release exists now, unused, so archival does not
have to retrofit a path through this module later.

The blob client calls the digest `hash` and the contract calls it `blobHash`;
the mapping lives in one function rather than at every call site."
```

---

### Task 8: portal worker 的 CAS binding 与真 workerd 往返

**Files:**
- Modify: `stacks/unidocs-cloudflare/local/services.mjs`
- Modify: `stacks/unidocs-cloudflare/local/runtime.mjs`
- Test: `tests/integration/cloudflare/portal-cas.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `createPlatformCasCapability`、Task 7 的 `createSnapshotStore`。
- Produces: portal worker 的 `CAS_ORIGIN`、`CAS_STACK_ID`、`CAS_AUDIENCE`、`CAS_REF_DOMAIN` binding 与签名密钥，供 Plan 2 的 repository 构造 blob client。

**Background（实施者必读）：**

- `pnpm dev portal` 默认就会启动 embedded CAS：`runtime.mjs` 在 `!casOrigin` 时启动 CAS middleware，并把 stack fixture（`stackId` / `issuer` / `audience` / `kid` / `jwks` / `refDomains`）写进 `CAS_CONTROL_DB`。
- 但 portal 组件当前**只有** `d1Binding: "DB"` 与 `r2Binding: "BUNDLES"`，没有任何 CAS 相关配置。
- `services.mjs` 必须保持**零 import**。只在表里加声明字段，真正的取值逻辑放 `runtime.mjs`。
- 参照 `tests/integration/cloudflare/portal-local-runtime.test.mjs` 的写法启动运行时。

- [ ] **Step 1: 写失败的集成测试**

创建 `tests/integration/cloudflare/portal-cas.test.mjs`：

```js
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { startRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startRuntime({ docTypes: [], services: ["portal"] });
}, 120_000);

afterAll(async () => {
  await runtime?.mf?.dispose();
});

describe("portal worker CAS bindings", () => {
  it("receives a CAS origin, stack identity, audience and ref domain", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_ORIGIN).toMatch(/^https?:\/\//);
    expect(bindings.CAS_STACK_ID).toBeTruthy();
    expect(bindings.CAS_AUDIENCE).toBeTruthy();
    expect(bindings.CAS_REF_DOMAIN).toBe("doc");
  });

  it("receives the stack signing key, not the gateway one", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_SIGNING_KEY).toContain("BEGIN PRIVATE KEY");
    expect(bindings.CAS_SIGNING_KID).toMatch(/^stack-local-/);
    expect(bindings.CAS_ISSUER).not.toMatch(/^unidocs-gateway:/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-cas.test.mjs --fileParallelism=false
```

Expected: FAIL，`CAS_ORIGIN` 为 `undefined`。

- [ ] **Step 3: 在 services.mjs 声明需求**

编辑 `stacks/unidocs-cloudflare/local/services.mjs`，在 portal 组件对象里 `r2Binding` 之后加入：

```js
      /**
       * The portal reads snapshot blobs out of UniCAS and retains their
       * business roots. It never writes blob content - an Agent does that
       * directly - so what it needs is a read credential plus the stack
       * authority that lets it move root references.
       *
       * Declared here, resolved in runtime.mjs: this file must stay
       * dependency-free, and the values come from the CAS fixture the runtime
       * already builds.
       */
      cas: true,
```

**不要**在此文件中 import 任何东西。

- [ ] **Step 4: 在 runtime.mjs 注入实际取值**

编辑 `stacks/unidocs-cloudflare/local/runtime.mjs`，在构造 service worker 的 bindings 处（`for (const component of serviceWorkers(services))` 附近，与 `devVars` 合并的位置一致），加入：

```js
      ...(component.cas
        ? {
            CAS_ORIGIN: casOrigin ?? urls.edge,
            CAS_STACK_ID: resolvedStackFixture.stackId,
            CAS_ISSUER: resolvedStackFixture.issuer,
            CAS_AUDIENCE: resolvedStackFixture.audience,
            CAS_REF_DOMAIN: "doc",
            CAS_SIGNING_KID: resolvedStackFixture.kid,
            CAS_SIGNING_KEY: resolvedStackFixture.privateKeyPkcs8,
          }
        : {}),
```

**为什么是 `stackFixture` 而不是 `capabilityFixture`。** 两个 fixture 都有 `privateKeyPkcs8`，用错了 CAS 会拒签。`seedMiddlewareStacks(controlDb, fixtureStacks)` 注册进 `CAS_CONTROL_DB` 的是 `resolvedStackFixture` 的 `publicJwk`，所以只有用 `resolvedStackFixture` 的私钥签出来的 token 才验得过。`resolvedCapabilityFixture` 是 gateway 的（issuer 形如 `unidocs-gateway:local:...`），与 CAS 无关。

**为什么 `CAS_REF_DOMAIN` 是字面量 `"doc"`。** `createEphemeralStackFixture` 返回的 `refDomains` 是**对象数组**：

```js
    refDomains: [
      { refDomain: "doc", status: "active" },
      { refDomain: "asset", status: "active" },
    ],
```

所以 `refDomains[0]` 是个对象而不是字符串。只有 `doc` 与 `asset` 两个域，文档 snapshot 属于 `doc`。若你想从 fixture 里取而不写字面量，要写 `resolvedStackFixture.refDomains.find(d => d.refDomain === "doc").refDomain`，等价但更绕。

`urls.edge` 在 portal-only 选择下存在：`resolvePorts` 之后的 `!casOrigin` 分支已经设了 `ports.edge = portOverrides.edge ?? EDGE_PORT`（runtime.mjs:459），`urls` 由 `ports` 构造。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-cas.test.mjs --fileParallelism=false
```

Expected: PASS。

- [ ] **Step 6: 跑既有测试确认没弄坏 dev 运行时**

```bash
pnpm exec vitest run tests/unit/scripts --fileParallelism=false
pnpm exec vitest run tests/integration/cloudflare/portal-local-runtime.test.mjs --fileParallelism=false
```

Expected: 全部 PASS。`tests/unit/scripts/services.test.mjs` 里有一条守卫会检查 `SERVICE_TARGETS` 与 `SERVICE_PLATFORMS` 命名一致——加字段不应触发它，若触发则说明改错了位置。

- [ ] **Step 7: 手工确认 portal 仍能启动**

```bash
pnpm dev portal
```

Expected: 终端打印 `Services: portal`，`http://127.0.0.1:8795/admin/` 与 `http://127.0.0.1:8795/portal/` 均可访问。确认后 Ctrl-C 退出。

- [ ] **Step 8: Commit**

```bash
git add stacks/unidocs-cloudflare/local/services.mjs stacks/unidocs-cloudflare/local/runtime.mjs tests/integration/cloudflare/portal-cas.test.mjs
git commit -m "feat(dev): give the portal worker its UniCAS bindings

The local runtime already starts an embedded CAS and registers the stack
fixture, but the portal was the one worker that never saw any of it. The
registry only declares that the component wants CAS; the values come from the
fixture the runtime builds, because services.mjs has to stay dependency-free."
```

---

### Task 9: 组装 SnapshotStore 并打通真实 CAS 往返

**Files:**
- Create: `packages/cloudflare-portal/src/cas-runtime.ts`
- Test: `tests/integration/cloudflare/portal-cas.test.mjs`（在 Task 8 建的文件上追加）

**Interfaces:**
- Consumes: Task 6 的 `createPlatformCasCapability`、Task 7 的 `createSnapshotStore`、Task 8 注入的 `CAS_*` bindings，以及 `@unidocs/service-auth` 的 `createPkcs8CapabilityIssuer`。
- Produces: `createPortalCasRuntime(env, tenantId): Promise<SnapshotStore>` —— Plan 2 的 `TenantVersionRepository` 与 Plan 3 的 submissions 端点都从这里拿 store。

**Background：** 这是 Plan 1 的收口。前面三个 task 各造了一段，但「从 binding 到一个能用的 `SnapshotStore`」这一步还没人做，而且整条链路从未对着真 CAS 跑过。

链路：`CAS_SIGNING_KEY` → `createPkcs8CapabilityIssuer` → `createPlatformCasCapability` → `createTenantCasClient` → `createCasBlobClient` → `createSnapshotStore`。

`createTenantCasClient` 不校验 origin 协议（只去掉尾部斜杠），所以本地的 `http://127.0.0.1:<edge>` 直接可用。

- [ ] **Step 1: 写失败的往返测试**

追加到 `tests/integration/cloudflare/portal-cas.test.mjs`：

```js
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { casReadPermission, casWritePermission, createPkcs8CapabilityIssuer } from "@unidocs/service-auth";
import { createPortalCasRuntime } from "../../../packages/cloudflare-portal/src/cas-runtime.ts";

const TENANT = "t-local";
const SNAPSHOT_TYPE = "application/vnd.unidocs.markdown.snapshot+cbor;version=1";

/** Stands in for an Agent: it may write node content, but carries no refDomain. */
async function agentBlobClient(runtime) {
  const fixture = runtime.stackFixture;
  const issuer = await createPkcs8CapabilityIssuer({
    issuer: fixture.issuer,
    kid: fixture.kid,
    privateKeyPkcs8: fixture.privateKeyPkcs8,
  });
  const cas = createTenantCasClient({
    baseUrl: runtime.urls.edge,
    stackId: fixture.stackId,
    tenantId: TENANT,
    getToken: () => issuer.issue({
      subject: "agent:test",
      audience: fixture.audience,
      tenantId: TENANT,
      permissions: [casReadPermission(TENANT), casWritePermission(TENANT)],
    }),
  });
  return createCasBlobClient(cas);
}

function bodyStream(bytes) {
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

describe("snapshot blob round trip", () => {
  it("reads back exactly what the Agent wrote, then retains its root", async () => {
    const payload = new TextEncoder().encode("# hello\n\nsnapshot bytes");

    const agent = await agentBlobClient(runtime);
    const written = await agent.storeBlob(bodyStream(payload), {
      contentType: SNAPSHOT_TYPE,
      size: payload.byteLength,
    });
    expect(written.hash).toBeTruthy();

    const bindings = await runtime.mf.getBindings("unidocs-portal");
    const store = await createPortalCasRuntime(bindings, TENANT);

    const ref = { blobHash: written.hash, size: written.size, contentType: written.contentType };
    const stream = await store.read(ref);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const readBack = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) { readBack.set(chunk, at); at += chunk.byteLength; }

    expect(readBack).toEqual(payload);

    await expect(store.retain(ref, `req-${crypto.randomUUID()}`)).resolves.toBeUndefined();
  }, 60_000);

  it("refuses a reference whose size disagrees with the stored blob", async () => {
    const payload = new TextEncoder().encode("mismatch");
    const agent = await agentBlobClient(runtime);
    const written = await agent.storeBlob(bodyStream(payload), {
      contentType: SNAPSHOT_TYPE,
      size: payload.byteLength,
    });

    const bindings = await runtime.mf.getBindings("unidocs-portal");
    const store = await createPortalCasRuntime(bindings, TENANT);

    await expect(
      store.read({ blobHash: written.hash, size: written.size + 1, contentType: written.contentType }),
    ).rejects.toThrow();
  }, 60_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-cas.test.mjs --fileParallelism=false
```

Expected: FAIL，`../../../packages/cloudflare-portal/src/cas-runtime.ts` 不存在。

- [ ] **Step 3: 实现组装模块**

创建 `packages/cloudflare-portal/src/cas-runtime.ts`：

```ts
/**
 * Assembles the Platform's snapshot store from worker bindings.
 *
 * The chain is: stack signing key -> capability issuer -> a read capability
 * carrying the stack's refDomain -> tenant CAS client -> blob client -> store.
 * It is assembled per tenant because a capability is tenant-scoped; the
 * issuer itself is not, so callers that serve many tenants should hoist the
 * issuer rather than re-import the key per request.
 */
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { createPkcs8CapabilityIssuer } from "@unidocs/service-auth";
import { createPlatformCasCapability } from "./cas-capability.js";
import { createSnapshotStore, type SnapshotStore } from "./snapshot-store.js";

export interface PortalCasEnv {
  readonly CAS_ORIGIN: string;
  readonly CAS_STACK_ID: string;
  readonly CAS_ISSUER: string;
  readonly CAS_AUDIENCE: string;
  readonly CAS_REF_DOMAIN: string;
  readonly CAS_SIGNING_KID: string;
  readonly CAS_SIGNING_KEY: string;
}

const PLATFORM_SUBJECT = "platform:portal";

export async function createPortalCasRuntime(
  env: PortalCasEnv,
  tenantId: string,
): Promise<SnapshotStore> {
  for (const name of [
    "CAS_ORIGIN", "CAS_STACK_ID", "CAS_ISSUER",
    "CAS_AUDIENCE", "CAS_REF_DOMAIN", "CAS_SIGNING_KID", "CAS_SIGNING_KEY",
  ] as const) {
    if (!env[name]) throw new TypeError(`Portal CAS binding ${name} is missing`);
  }

  const issuer = await createPkcs8CapabilityIssuer({
    issuer: env.CAS_ISSUER,
    kid: env.CAS_SIGNING_KID,
    privateKeyPkcs8: env.CAS_SIGNING_KEY,
  });

  const cas = createTenantCasClient({
    baseUrl: env.CAS_ORIGIN,
    stackId: env.CAS_STACK_ID,
    tenantId,
    getToken: createPlatformCasCapability({
      issuer,
      tenantId,
      audience: env.CAS_AUDIENCE,
      subject: PLATFORM_SUBJECT,
      refDomain: env.CAS_REF_DOMAIN,
    }),
  });

  return createSnapshotStore(createCasBlobClient(cas));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run tests/integration/cloudflare/portal-cas.test.mjs --fileParallelism=false
```

Expected: PASS，两个用例都过。

**若 retain 被 CAS 拒绝**，最可能的原因是 Platform capability 的 permission 不足以移动 root reference——`createPlatformCasCapability` 目前只申请 `casReadPermission`。读 CAS 服务端对 root-ref 写入的权限判定，把所需的 permission 补进 Task 6 的 `permissions` 数组，并同步更新 `packages/cloudflare-portal/tests/cas-capability.test.ts` 的断言。**不要**通过给 Agent 加 refDomain 来绕过：refDomain 是 stack authority 的标志，Agent 不该有。

- [ ] **Step 5: 跑全量确认没有回归**

```bash
pnpm --filter @unidocs/cloudflare-portal test
pnpm -r typecheck
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-portal/src/cas-runtime.ts tests/integration/cloudflare/portal-cas.test.mjs
git commit -m "feat(portal): assemble the snapshot store from worker bindings

Closes the chain the previous commits left in pieces: signing key to issuer to
capability to CAS client to blob client to store. The integration test writes a
blob the way an Agent does - a capability with no refDomain - and reads it back
through the Platform's own, which is the split the design requires."
```

---

## Plan 1 完成标准

- [ ] `pnpm --filter @unidocs/protocol-platform test` 通过
- [ ] `pnpm --filter @unidocs/cloudflare-portal test` 通过
- [ ] `pnpm -r typecheck` 通过
- [ ] `pnpm exec vitest run tests/unit/scripts tests/integration/cloudflare --fileParallelism=false` 通过
- [ ] `pnpm dev portal` 能启动，两个控制台都可访问

产出给 Plan 2 的接口：`agentApiContract`、`SubmissionReceiptSchema`、`createPlatformCasCapability`、`createSnapshotStore`，以及 portal worker 上可用的 `CAS_*` bindings。
