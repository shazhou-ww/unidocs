export interface CommitRequestIdentity {
  opId: string;
  requestDigest: string;
  baseVersion: number;
}

export type CommitReceipt = CommitRequestIdentity & (
  | { state: "pending" }
  | { state: "committed"; version: number }
  | { state: "rejected"; reason: "version_conflict"; headVersion: number }
  | { state: "rejected"; reason: "invalid_operations" }
  | { state: "unknown"; reason: "not_found" | "expired" | "unavailable" }
);

export function parseCommitRequestIdentity(value: unknown): CommitRequestIdentity {
  const record = requireRecord(value);
  if (typeof record.opId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.opId)
    || typeof record.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.requestDigest)
    || !isVersion(record.baseVersion) || record.baseVersion === Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid commit request identity");
  }
  return { opId: record.opId, requestDigest: record.requestDigest, baseVersion: record.baseVersion };
}

export function parseCommitReceipt(value: unknown): CommitReceipt {
  const record = requireRecord(value);
  const identity = parseCommitRequestIdentity(record);
  if (record.state === "committed") {
    if (record.version !== identity.baseVersion + 1 || record.reason !== undefined || record.headVersion !== undefined) {
      throw new Error("Invalid committed receipt");
    }
    return { ...identity, state: "committed", version: record.version as number };
  }
  if (record.version !== undefined) throw new Error("Unconfirmed receipt cannot carry a committed version");
  if (record.state === "rejected" && record.reason === "version_conflict" && isVersion(record.headVersion)) {
    return { ...identity, state: "rejected", reason: "version_conflict", headVersion: record.headVersion };
  }
  if (record.headVersion !== undefined) throw new Error("Invalid receipt head version");
  if (record.state === "pending" && record.reason === undefined) return { ...identity, state: "pending" };
  if (record.state === "rejected" && record.reason === "invalid_operations") {
    return { ...identity, state: "rejected", reason: "invalid_operations" };
  }
  if (record.state === "unknown" && ["not_found", "expired", "unavailable"].includes(record.reason as string)) {
    return { ...identity, state: "unknown", reason: record.reason as "not_found" | "expired" | "unavailable" };
  }
  throw new Error("Invalid commit receipt state");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid commit record");
  return value as Record<string, unknown>;
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}