import type { ContractRouterClient } from "@orpc/contract";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { CasStack } from "../src/index.js";
import { CasStackSchema, casAdminApiContract } from "../src/index.js";
import { renderAdminApiReferenceHtml } from "../scripts/html.js";
import { generateAdminOpenApiDocument } from "../scripts/openapi.js";

const methods = ["get", "post", "put", "patch", "delete"] as const;

function operations(document: Awaited<ReturnType<typeof generateAdminOpenApiDocument>>) {
  return Object.values(document.paths ?? {}).flatMap((item) =>
    methods.flatMap((method) => {
      const operation = item?.[method];
      return operation === undefined ? [] : [operation];
    }),
  );
}

describe("CAS admin schemas", () => {
  test("validates stack wire records", () => {
    expect(CasStackSchema.safeParse({
      stackId: "stack-1",
      displayName: "Stack 1",
      description: "",
      status: "active",
      createdAt: 1,
      revision: 1,
    }).success).toBe(true);
  });

  test("exposes a client type derived from the contract", () => {
    type Client = ContractRouterClient<typeof casAdminApiContract>;
    type Stack = Awaited<ReturnType<Client["stacks"]["get"]>>;
    expectTypeOf<Stack>().toEqualTypeOf<CasStack>();
  });
});

describe("CAS admin OpenAPI", () => {
  test("describes every control-plane operation", async () => {
    const document = await generateAdminOpenApiDocument();
    const allOperations = operations(document);

    expect(document.openapi).toBe("3.1.1");
    expect(Object.keys(document.paths ?? {})).toHaveLength(16);
    expect(allOperations).toHaveLength(23);
    expect(new Set(allOperations.map((operation) => operation.operationId)).size).toBe(23);
    expect(document.security).toEqual([{ adminSession: [] }]);
  });

  test("documents optimistic concurrency and renders standalone HTML", async () => {
    const document = await generateAdminOpenApiDocument();
    const patch = document.paths?.["/admin/stacks/{stackId}"]?.patch;
    const parameterNames = (patch?.parameters ?? []).map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    );
    expect(parameterNames).toContain("if-match");
    expect(patch?.responses).toHaveProperty("412");
    expect(patch?.responses).toHaveProperty("428");

    const html = renderAdminApiReferenceHtml(document);
    expect(html).toContain("Scalar.createApiReference");
    expect(html).toContain("\"openapi\":\"3.1.1\"");
  });
});