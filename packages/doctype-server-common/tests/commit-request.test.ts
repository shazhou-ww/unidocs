import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createSBlob, decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import { computeCommitRequestDigest } from "../src/commit-request.js";

const identity = { tenantId: "tenant", docType: "markdown", sessionId: "session" };
const payload = { baseVersion: 1, description: "edit", operations: [{ kind: "setContent", payload: { content: "# Draft" } }] };

it("uses full SHA-256 over a domain-separated canonical SValue payload", async () => {
  const expected = createHash("sha256").update(encodeSValue({ domain: "unidocs.commit.v1", ...identity, ...payload })).digest("hex");
  const digest = await computeCommitRequestDigest(identity, payload);
  expect(digest).toBe(expected);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(await computeCommitRequestDigest(identity, {
    operations: [{ payload: { content: "# Draft" }, kind: "setContent" }], description: "edit", baseVersion: 1,
  })).toBe(digest);
});

it("binds the payload to immutable session scope, base version, description and operation order", async () => {
  const digest = await computeCommitRequestDigest(identity, payload);
  for (const key of ["tenantId", "docType", "sessionId"] as const) {
    expect(await computeCommitRequestDigest({ ...identity, [key]: "another" }, payload)).not.toBe(digest);
  }
  expect(await computeCommitRequestDigest(identity, { ...payload, baseVersion: 2 })).not.toBe(digest);
  expect(await computeCommitRequestDigest(identity, { ...payload, description: "changed" })).not.toBe(digest);
  expect(await computeCommitRequestDigest(identity, { ...payload, operations: [{ kind: "setContent", payload: { content: "other" } }] })).not.toBe(digest);
  const operations = [{ kind: "append", text: "first" }, { kind: "append", text: "second" }];
  expect(await computeCommitRequestDigest(identity, { ...payload, operations }))
    .not.toBe(await computeCommitRequestDigest(identity, { ...payload, operations: [...operations].reverse() }));
});

it("preserves SBlob identity across wire decoding without treating a plain hash object as a blob", async () => {
  const blob = createSBlob("ab".repeat(32));
  const operations = [{ kind: "insert", blob }];
  const digest = await computeCommitRequestDigest(identity, { ...payload, operations });
  const decoded = decodeSValue(encodeSValue(operations)) as typeof operations;
  expect(await computeCommitRequestDigest(identity, { ...payload, operations: decoded })).toBe(digest);
  expect(await computeCommitRequestDigest(identity, { ...payload, operations: [{ kind: "insert", blob: { hash: blob.hash } }] })).not.toBe(digest);
  expect(await computeCommitRequestDigest(identity, { ...payload, operations: [{ kind: "insert", blob: createSBlob("cd".repeat(32)) }] })).not.toBe(digest);
});

it("captures the candidate synchronously before awaiting the hash", async () => {
  const candidate = { ...payload, operations: [{ kind: "setContent", payload: { content: "original" } }] };
  const expected = await computeCommitRequestDigest(identity, candidate);
  const pending = computeCommitRequestDigest(identity, candidate);
  candidate.operations[0]!.payload.content = "later edit";
  expect(await pending).toBe(expected);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, NaN])("rejects invalid base version %s", async baseVersion => {
  await expect(computeCommitRequestDigest(identity, { ...payload, baseVersion })).rejects.toThrow("Invalid commit payload");
});

it("rejects missing session identity", async () => {
  await expect(computeCommitRequestDigest({ ...identity, sessionId: "" }, payload)).rejects.toThrow("Invalid commit payload");
});