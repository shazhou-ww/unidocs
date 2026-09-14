import { describe, expect, it } from "vitest";
import {
  agentApiContract,
  AgentApiV1BasePath,
  createSubmissionContract,
  operatorWebhookContract,
} from "../src/contract.js";

describe("agentApiContract", () => {
  it("posts submissions under the tenant-scoped document path", () => {
    const route = agentApiContract.submissions.create["~orpc"].route;
    expect(route.method).toBe("POST");
    expect(route.path).toBe(`${AgentApiV1BasePath}/documents/{documentId}/submissions`);
    expect(route.successStatus).toBe(201);
  });

  it("accepts a rejected receipt as a successful (2xx) submission output, not just the committed branch", () => {
    // A rejected submission is a successful response carrying a receipt, per
    // the module doc on createSubmissionContract. If .output() were ever
    // narrowed to only the committed branch, this must fail loudly here
    // rather than surface later as an Operator-side decoding bug.
    const rejectedReceipt = {
      submissionId: "sub-1",
      state: "rejected",
      reason: "version_conflict",
      conflict: {
        currentVersionIdx: 4,
        availableDocumentContractIdxs: [0],
        threads: [{ threadId: "th-1", acknowledgedCommentIdx: 1, latestCommentIdx: 2 }],
      },
      rejectedAt: "2026-09-12T00:00:00.000Z",
    };
    const outputSchema = createSubmissionContract["~orpc"].outputSchema;
    expect(outputSchema?.safeParse(rejectedReceipt).success).toBe(true);
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
