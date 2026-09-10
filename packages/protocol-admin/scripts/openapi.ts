import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { adminApiContract } from "../src/contract.js";

const mutationMethods = ["post", "put", "patch", "delete"] as const;

export async function generateAdminOpenApiDocument() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  const document = await generator.generate(adminApiContract, {
    info: {
      title: "UniDocs Administrator API",
      version: "0.1.0",
      description: [
        "Administrator control-plane API for configuring UniDocs document types.",
        "",
        "The API manages document type registrations, append-only paired Document Contract revisions, immutable Type Card and View bundles, Operator candidates, administrator membership, and control-plane audit events.",
        "",
        "Every request supports either a Bearer token or the same-origin administrator session cookie. If an `Authorization: Bearer` header is present, the server uses only that token and must not fall back to cookie authentication when token authentication fails. Mutations authenticated by cookie additionally require `X-CSRF-Token`; Bearer-authenticated mutations do not. All mutations require `Idempotency-Key`, and conditional metadata and registration updates also require `If-Match`.",
      ].join("\n"),
    },
    tags: [
      {
        name: "Document types",
        description: "Document type drafts and their currently selected Type Card bundle, View bundle, Operator candidate, and enabled state.",
      },
      {
        name: "Document Contracts",
        description: "Append-only bundles that pair snapshot and location schemas under one revision. Bundles may be uploaded at any time, and every compatible revision remains available for new data.",
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
      {
        name: "Audit",
        description: "Immutable administrator control-plane events for investigation, attribution, and request correlation.",
      },
    ],
    security: [{ adminBearer: [] }, { adminSession: [] }],
    components: {
      securitySchemes: {
        adminBearer: {
          type: "http",
          scheme: "bearer",
          description: "Administrator client token. Its presence selects Bearer authentication exclusively; an invalid token never falls back to the session cookie.",
        },
        adminSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-unidocs_admin",
          description: "HttpOnly same-origin administrator session cookie",
        },
        adminCsrf: {
          type: "apiKey",
          in: "header",
          name: "X-CSRF-Token",
          description: "CSRF token required for mutations authenticated with the administrator session cookie",
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

  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of mutationMethods) {
      const operation = pathItem?.[method];
      if (operation !== undefined) {
        operation.security = [
          { adminBearer: [] },
          { adminSession: [], adminCsrf: [] },
        ];
      }
    }
  }

  return document;
}