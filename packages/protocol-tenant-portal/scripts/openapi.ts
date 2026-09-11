import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { tenantApiContract } from "../src/contract.js";

const mutationMethods = ["post", "put", "patch", "delete"] as const;

export async function generateTenantOpenApiDocument() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  const document = await generator.generate(tenantApiContract, {
    info: {
      title: "UniDocs Tenant API",
      version: "0.1.0",
      description: [
        "End-user data-plane API for the UniDocs Platform.",
        "",
        "The Platform is the single persistent authority for documents, immutable versions, the current pointer, position-anchored threads, and content references. People contribute comments; only an Operator Agent produces versions, so this API has no operation that edits document content.",
        "",
        "A thread's open state is derived, never stored: a thread is open while its latest ping is beyond the cumulative pong watermark. There is therefore no resolve or reopen operation, and pings are immutable — a correction is a new ping on the same thread.",
        "",
        "Every request supports either a Bearer token or the same-origin tenant session cookie. If an `Authorization: Bearer` header is present, the server uses only that token and must not fall back to cookie authentication when token authentication fails; this is how an Operator Agent reads the same authoritative data as a user, with `documents:read`, `comments:read`, and `cas:read` scopes. Mutations authenticated by cookie additionally require `X-CSRF-Token`; Bearer-authenticated mutations do not. Creating a document, a thread, or a ping requires `Idempotency-Key`; moving the current pointer does not, because `observedCurrentVersionIdx` is already an equality lock.",
        "",
        "The Platform never proxies UniCAS node traffic. Rich message bodies, attachments, and large binary values inside a snapshot are `CasBlobRef` / `SBlob` references that the caller reads directly from UniCAS with a short-lived tenant capability.",
      ].join("\n"),
    },
    tags: [
      {
        name: "Document types",
        description: "The catalog of enabled document types and the immutable paired contract revisions that validate their snapshots and locations.",
      },
      {
        name: "Documents",
        description: "Document identity, the current version pointer, and the audited move of that pointer. Creating a document notifies its Operator, which commits the first snapshot.",
      },
      {
        name: "Versions",
        description: "Immutable versions in birth order. Metadata carries both graphs — the base parent forest and comment provenance — while snapshot bytes are read one version at a time.",
      },
      {
        name: "Threads",
        description: "Position-anchored discussions holding an append-only user ping sequence and an append-only Agent pong sequence.",
      },
      {
        name: "Audit",
        description: "Immutable document-level events, recorded because moving the current pointer changes the baseline later versions and submissions are built on.",
      },
      {
        name: "CAS",
        description: "Short-lived tenant capabilities for reading and writing UniCAS content directly, without routing bytes through the Platform.",
      },
    ],
    security: [{ tenantBearer: [] }, { tenantSession: [] }],
    components: {
      securitySchemes: {
        tenantBearer: {
          type: "http",
          scheme: "bearer",
          description: "Platform OAuth access token. Its presence selects Bearer authentication exclusively; an invalid token never falls back to the session cookie. Agent scopes are `documents:read`, `cas:read`, `cas:lease`, `comments:read`, `comments:pong`, and `versions:submit`; this API uses the read scopes, and `versions:submit` belongs to the separate Agent submission API.",
        },
        tenantSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-unidocs_tenant",
          description: "HttpOnly same-origin end-user session cookie",
        },
        tenantCsrf: {
          type: "apiKey",
          in: "header",
          name: "X-CSRF-Token",
          description: "CSRF token required for mutations authenticated with the session cookie",
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
          { tenantBearer: [] },
          { tenantSession: [], tenantCsrf: [] },
        ];
      }
    }
  }

  return document;
}
