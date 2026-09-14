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
