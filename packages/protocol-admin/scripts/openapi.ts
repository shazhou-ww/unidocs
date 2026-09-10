import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { adminApiContract } from "../src/contract.js";

export function generateAdminOpenApiDocument() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  return generator.generate(adminApiContract, {
    info: {
      title: "UniDocs Administrator API",
      version: "0.1.0",
      description: [
        "Administrator control-plane API for configuring UniDocs document types.",
        "",
        "The API manages document type registrations, append-only Snapshot Contract revisions, immutable Type Card and View bundles, Operator candidates, and administrator membership.",
        "",
        "All requests require the same-origin administrator session cookie. Mutations additionally require `X-CSRF-Token` and `Idempotency-Key`; conditional metadata and registration updates also require `If-Match`.",
      ].join("\n"),
    },
    tags: [
      {
        name: "Document types",
        description: "Document type drafts and their currently selected Type Card bundle, View bundle, Operator candidate, and enabled state.",
      },
      {
        name: "Snapshot Contracts",
        description: "Append-only SValue schema revisions. The highest revision is always latest; historical revisions are immutable and remain available for reading old versions.",
      },
      {
        name: "Type Card bundles",
        description: "Immutable, content-addressed bundles used to present document types in creation experiences. Administrator name and description metadata remain mutable under an ETag precondition.",
      },
      {
        name: "View bundles",
        description: "Immutable, content-addressed browser View bundles. Uploading a bundle does not bind it to a document type; binding is an explicit document type update.",
      },
      {
        name: "Operators",
        description: "Validate Operator endpoints without user data, then persist successful validations as administrator-visible candidates that can be bound to document types.",
      },
      {
        name: "Members",
        description: "Manage the Google-account administrator allowlist. Membership creation is idempotent, and removal requires the current ETag while preserving at least one administrator.",
      },
    ],
    security: [{ adminSession: [] }],
    components: {
      securitySchemes: {
        adminSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-unidocs_admin",
          description: "HttpOnly same-origin administrator session cookie",
        },
      },
    },
    customErrorResponseBodySchema: (definedErrors) => ({
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: {
              type: "string",
              enum: definedErrors.map(([code]) => code.toLowerCase()),
            },
            message: { type: "string" },
            requestId: { type: "string" },
            details: {},
          },
          required: ["code", "message", "requestId"],
        },
      },
      required: ["error"],
    }),
  });
}