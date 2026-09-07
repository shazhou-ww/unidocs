import { expect, it } from "vitest";
import { parseCommitReceipt, parseCommitRequestIdentity } from "../src/index.js";

const identity = { opId: "commit-1", requestDigest: "ab".repeat(32), baseVersion: 12 };

it.each([
  { state: "pending" },
  { state: "committed", version: 13 },
  { state: "rejected", reason: "version_conflict", headVersion: 15 },
  { state: "rejected", reason: "invalid_operations" },
  { state: "unknown", reason: "not_found" },
  { state: "unknown", reason: "expired" },
  { state: "unknown", reason: "unavailable" },
])("validates metadata-only receipt %j", state => {
  const receipt = { ...identity, ...state };
  expect(parseCommitReceipt({ ...receipt, accessToken: "private", operations: ["private"] })).toEqual(receipt);
});

it.each([
  null, [], {},
  { ...identity, opId: "" },
  { ...identity, opId: "x".repeat(129) },
  { ...identity, opId: "invalid/id" },
  { ...identity, requestDigest: "short" },
  { ...identity, requestDigest: "AB".repeat(32) },
  { ...identity, baseVersion: 0 },
  { ...identity, baseVersion: 1.5 },
  { ...identity, baseVersion: Number.MAX_SAFE_INTEGER },
])("rejects invalid identity %j", value => {
  expect(() => parseCommitRequestIdentity(value)).toThrow();
});

it.each([
  { state: "committed" },
  { state: "committed", version: 15 },
  { state: "committed", version: 13, reason: "unavailable" },
  { state: "committed", version: 13, headVersion: 15 },
  { state: "pending", version: 13 },
  { state: "pending", reason: "expired" },
  { state: "unknown", reason: "not_found", version: 13 },
  { state: "unknown", reason: "not_found", headVersion: 15 },
  { state: "rejected", reason: "timeout" },
  { state: "rejected", reason: "version_conflict" },
  { state: "rejected", reason: "version_conflict", headVersion: 0 },
  { state: "rejected", reason: "invalid_operations", version: 13 },
  { state: "failed" },
])("never interprets ambiguous or malformed results as a commit %j", state => {
  expect(() => parseCommitReceipt({ ...identity, ...state })).toThrow();
});