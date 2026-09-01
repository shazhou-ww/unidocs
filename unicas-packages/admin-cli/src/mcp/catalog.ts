/**
 * Tool catalog for `unicas mcp` and the CLI commands.
 *
 * Names, descriptions, input schemas, and annotations mirror the remote
 * MCP ingress hosted by `@unicas/service-cloudflare`
 * (`src/mcp/server.ts`); the CLI must never drift from that contract.
 * Required scopes document what the remote enforces; the CLI does not
 * re-issue scope decisions.
 */

import { z } from "zod";

export type ControlPlaneToolScope = "control:read" | "control:write" | "control:security";

export interface ToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly annotations: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly requiredScope: ControlPlaneToolScope;
}

const stackId = z.string().min(1);
const cursor = z.string().min(1);
const boundedLimit = z.number().int().min(1).max(200);
const displayName = z.string().min(1).max(100);
const description = z.string().max(2_000);
const idempotencyKey = z.string().min(1).max(128);
const etag = z.string().min(1);
const email = z.string().email();
const url = z.string().url();
const keyAlgorithm = z.enum(["ES256", "RS256", "EdDSA"]);
const keyState = z.enum(["retiring", "revoked"]);
const refDomain = z.string().min(1).max(64);

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  {
    name: "whoami",
    title: "Current Unicas operator",
    description: "Return the authenticated operator identity and current stack memberships.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_stacks",
    title: "List Unicas stacks",
    description: "List stacks administered by the authenticated operator.",
    inputSchema: z.object({
      limit: boundedLimit.optional(),
      cursor: cursor.optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "get_stack",
    description: "Get one administered stack and its current mutation ETag.",
    inputSchema: z.object({ stackId }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_members",
    description: "List administrators for a stack.",
    inputSchema: z.object({
      stackId,
      limit: boundedLimit.optional(),
      cursor: cursor.optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "get_issuer",
    description: "Get the tenant JWT issuer and current mutation ETag for a stack.",
    inputSchema: z.object({ stackId }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "get_oauth_issuer",
    description: "Get discovered OAuth issuer metadata, status, and current mutation ETag for a stack.",
    inputSchema: z.object({ stackId }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_issuer_keys",
    description: "List public issuer keys and their lifecycle states.",
    inputSchema: z.object({ stackId }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_ref_domains",
    description: "List refDomains observed in successful Root Ref audit writes.",
    inputSchema: z.object({ stackId }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_control_audit_events",
    description: "List append-only control-plane audit events for a stack.",
    inputSchema: z.object({
      stackId,
      limit: boundedLimit.optional(),
      cursor: cursor.optional(),
      after: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_root_domain_refs",
    description: "List current non-zero Root Ref balances for one refDomain.",
    inputSchema: z.object({
      stackId,
      refDomain,
      tenantId: z.string().min(1).optional(),
      limit: boundedLimit.optional(),
      cursor: cursor.optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "list_root_domain_events",
    description: "List ordered Root Ref audit events for one refDomain.",
    inputSchema: z.object({
      stackId,
      refDomain,
      tenantId: z.string().min(1).optional(),
      after: z.number().int().min(0).optional(),
      limit: boundedLimit.optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false },
    requiredScope: "control:read",
  },
  {
    name: "create_stack",
    description: "Create a new stack administered by the current operator.",
    inputSchema: z.object({ displayName, idempotencyKey }),
    annotations: { destructiveHint: false, idempotentHint: true },
    requiredScope: "control:write",
  },
  {
    name: "update_stack",
    description: "Update stack metadata using its current ETag.",
    inputSchema: z.object({
      stackId,
      displayName: displayName.optional(),
      description: description.optional(),
      etag,
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    requiredScope: "control:write",
  },
  {
    name: "invite_member",
    description: "Create an email-bound invitation granting equal stack administrator authority.",
    inputSchema: z.object({ stackId, email, confirmEmail: email, idempotencyKey }),
    annotations: { destructiveHint: false, idempotentHint: true },
    requiredScope: "control:security",
  },
  {
    name: "remove_member",
    description: "Remove a stack administrator using the stack's current ETag.",
    inputSchema: z.object({
      stackId,
      identityIssuer: url,
      subject: z.string().min(1),
      etag,
      confirmSubject: z.string().min(1),
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    requiredScope: "control:security",
  },
  {
    name: "set_issuer",
    description: "Deprecated: manually create or update a stack tenant JWT issuer. Prefer inspect_oauth_issuer and activate_oauth_issuer.",
    inputSchema: z.object({
      stackId,
      issuer: url,
      audience: z.string().min(1),
      etag,
      confirmIssuer: url,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    requiredScope: "control:security",
  },
  {
    name: "inspect_oauth_issuer",
    description: "Discover and persist a validated OAuth issuer metadata and JWKS snapshot, returning a control challenge.",
    inputSchema: z.object({
      stackId,
      issuer: url,
    }).strict(),
    annotations: { destructiveHint: false, idempotentHint: false },
    requiredScope: "control:security",
  },
  {
    name: "activate_oauth_issuer",
    description: "Activate an inspected OAuth issuer using a compact-JWS control proof and current ETag.",
    inputSchema: z.object({
      stackId,
      inspectionId: z.string().min(1),
      activationProof: z.string().min(1),
      etag: etag.optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    requiredScope: "control:security",
  },
  {
    name: "create_issuer_key_challenge",
    description: "Deprecated: create the one-time challenge used by legacy manual issuer-key registration.",
    inputSchema: z.object({ stackId, kid: z.string().min(1), algorithm: keyAlgorithm }),
    annotations: { destructiveHint: false, idempotentHint: false },
    requiredScope: "control:security",
  },
  {
    name: "add_issuer_key",
    description: "Deprecated: manually add a public issuer key with a compact-JWS possession proof.",
    inputSchema: z.object({
      stackId,
      kid: z.string().min(1),
      algorithm: keyAlgorithm,
      publicJwk: z.record(z.string(), z.unknown()),
      possessionProof: z.string().min(1),
      idempotencyKey,
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
    requiredScope: "control:security",
  },
  {
    name: "transition_issuer_key",
    description: "Deprecated: transition a manually managed issuer key to retiring or revoked.",
    inputSchema: z.object({
      stackId,
      kid: z.string().min(1),
      state: keyState,
      etag,
      confirmKid: z.string().min(1),
      confirmState: keyState,
    }),
    annotations: { destructiveHint: true, idempotentHint: false },
    requiredScope: "control:security",
  },
];

const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool]));

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return CATALOG_BY_NAME.get(name);
}

/** Default idempotency key generator for creation commands. */
export function generateIdempotencyKey(): string {
  return `unicas-cli:${crypto.randomUUID()}`;
}
