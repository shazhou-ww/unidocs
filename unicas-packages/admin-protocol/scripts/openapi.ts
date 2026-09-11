import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { casAdminApiContract } from "../src/contract.js";

export function generateAdminOpenApiDocument() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  return generator.generate(casAdminApiContract, {
    info: {
      title: "UniCAS Administrator API",
      version: "0.1.0",
      description: "Administrator control-plane API for stacks, membership, OAuth issuers, Playground roots, and audit data.",
    },
    tags: [
      { name: "Identity", description: "Inspect the authenticated administrator and stack memberships." },
      { name: "Stacks", description: "Create, list, inspect, and update UniCAS stacks." },
      { name: "Members", description: "Manage equal-authority stack members and invitations." },
      { name: "Playground", description: "Manage Playground business roots that retain CAS manifests." },
      { name: "OAuth Issuer", description: "Discover, prove control of, and activate external Stack OAuth issuers." },
      { name: "Managed Issuer", description: "Configure the UniCAS-managed issuer and mint development capabilities." },
      { name: "Audit", description: "Read append-only administrator control events." },
      { name: "Root Ref Audit", description: "Inspect refDomains, balances, and append-only Root Ref events." },
    ],
    security: [{ adminSession: [] }],
    components: {
      securitySchemes: {
        adminSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-unicas_admin",
          description: "HttpOnly same-origin administrator session cookie",
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