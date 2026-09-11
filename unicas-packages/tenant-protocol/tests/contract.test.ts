import type { ContractRouterClient } from "@orpc/contract";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { CasUsage } from "../src/index.js";
import { CasHashSchema, CasRootRefUpdateSchema, casTenantApiContract } from "../src/index.js";
import { generateTenantOpenApiDocument } from "../scripts/openapi.js";

describe("CAS tenant schemas", () => {
  test("validates hashes and signed Root Ref changes", () => {
    expect(CasHashSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(CasHashSchema.safeParse("ABC").success).toBe(false);
    expect(CasRootRefUpdateSchema.safeParse({
      requestId: "commit-1",
      changes: { ["a".repeat(64)]: -1 },
    }).success).toBe(true);
  });

  test("exposes a client type derived from the contract", () => {
    type Client = ContractRouterClient<typeof casTenantApiContract>;
    type Usage = Awaited<ReturnType<Client["operations"]["getUsage"]>>;
    expectTypeOf<Usage>().toEqualTypeOf<CasUsage>();
  });
});

describe("CAS tenant OpenAPI", () => {
  test("describes every operation and embeds the specification in HTML", async () => {
    const document = await generateTenantOpenApiDocument();
    const operationIds = Object.values(document.paths ?? {}).flatMap((item) =>
      [item?.get, item?.post, item?.put, item?.patch, item?.delete]
        .flatMap((operation) => operation?.operationId ? [operation.operationId] : []),
    );

    expect(document.openapi).toBe("3.1.1");
    expect(Object.keys(document.paths ?? {})).toHaveLength(6);
    expect(operationIds).toHaveLength(7);
    expect(document.security).toEqual([{ tenantCapability: [] }]);
    expect(document.info.description).toContain("## Node lifecycle");
    expect(document.info.description).toContain("## Root Ref commit");
    expect(document.paths?.["/stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease"]?.post?.description)
      .toContain("direct `PUT` upload");
    expect(document.paths?.["/stacks/{stackId}/tenants/{tenantId}/root-refs"]?.post?.description)
      .toContain("business commit boundary");
    expect(document.paths?.["/stacks/{stackId}/tenants/{tenantId}/cas/usage"]?.get)
      .toHaveProperty(
        "responses.200.content.application/json.schema.properties.reservedBytes.description",
      );
  });
});