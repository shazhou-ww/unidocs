import type { SValue } from "@unidocs/protocol";
import { encodeSValue } from "@unidocs/svalue-codec";
import type { SessionIdentity } from "./ports.js";

export interface CommitPayload {
  baseVersion: number;
  description: string;
  operations: readonly SValue[];
}

export async function computeCommitRequestDigest(identity: SessionIdentity, payload: CommitPayload): Promise<string> {
  if (![identity.tenantId, identity.docType, identity.sessionId].every(value => typeof value === "string" && value.length > 0)
    || !Number.isSafeInteger(payload.baseVersion) || payload.baseVersion < 1 || payload.baseVersion === Number.MAX_SAFE_INTEGER
    || typeof payload.description !== "string" || !Array.isArray(payload.operations)) {
    throw new Error("Invalid commit payload");
  }
  const bytes = encodeSValue({
    domain: "unidocs.commit.v1",
    tenantId: identity.tenantId,
    docType: identity.docType,
    sessionId: identity.sessionId,
    baseVersion: payload.baseVersion,
    description: payload.description,
    operations: [...payload.operations],
  });
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}