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
      description: [
        "Tenant data-plane API for immutable content-addressed nodes, temporary leases, usage accounting, garbage collection, and atomic Root Ref commits.",
        "",
        "## Authentication and isolation",
        "",
        "Every request uses a Stack-issued JWT capability in `Authorization: Bearer`. The capability must match the `{stackId}` and `{tenantId}` resource path and grant the operation-specific CAS permission. Root Ref operations additionally use the capability's `refDomain`; it is intentionally not accepted as caller input. A tenant capability is never valid on the `/admin` control plane.",
        "",
        "## Node lifecycle",
        "",
        "Nodes are immutable and identified by the lowercase SHA-256 digest of their canonical bytes. Prepare new state by leasing each required node and completing any returned direct upload. A lease protects uncommitted data from garbage collection but does not make it durable business state.",
        "",
        "## Root Ref commit",
        "",
        "Commit a prepared DAG by atomically applying all Root Ref deltas with one stable `requestId`. Positive Root Refs are authoritative retained state; negative deltas release old roots. If the response is lost, repeat the identical request. Never generate a new requestId for an uncertain commit.",
        "",
        "## Errors and time values",
        "",
        "Error bodies contain a stable uppercase `error` code and may include a human-readable `message`; clients should branch on the code. All numeric timestamps are Unix milliseconds. Opaque upload identities and pagination cursors must not be parsed or modified.",
      ].join("\n"),
    },
    tags: [
      { name: "Nodes", description: "Read immutable DAG nodes and establish or extend temporary protection leases. Lease readiness and upload instructions describe the prepare phase before a Root Ref commit." },
      { name: "Root Refs", description: "Read and atomically update business-root balances in the verified capability's refDomain. Updates are idempotent commit operations, not best-effort counters." },
      { name: "Operations", description: "Inspect volatile tenant storage accounting and run race-safe, bounded garbage collection passes." },
    ],
    security: [{ tenantCapability: [] }],
    components: {
      securitySchemes: {
        tenantCapability: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Stack-issued JWT capability. Its resource scope must match the path and its permission set must grant the requested CAS operation.",
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