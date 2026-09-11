import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { casTenantApiContract } from "../src/contract.js";

export function generateTenantOpenApiDocument() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  return generator.generate(casTenantApiContract, {
    info: {
      title: "UniCAS Tenant API",
      version: "0.1.0",
      description: "Tenant data-plane API for immutable CAS nodes, leases, usage, garbage collection, and signed Root Ref updates.",
    },
    tags: [
      { name: "Nodes", description: "Read immutable nodes and establish or extend upload leases." },
      { name: "Root Refs", description: "Read and atomically update capability-scoped Root Ref balances." },
      { name: "Operations", description: "Inspect tenant usage and run bounded garbage collection." },
    ],
    security: [{ tenantCapability: [] }],
    components: {
      securitySchemes: {
        tenantCapability: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Stack-issued tenant capability",
        },
      },
    },
    customErrorResponseBodySchema: (definedErrors) => ({
      type: "object",
      properties: {
        error: { type: "string", enum: definedErrors.map(([code]) => code) },
        message: { type: "string" },
      },
      required: ["error"],
    }),
  });
}