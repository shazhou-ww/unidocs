import { z } from "zod";
import type { CasManagedCapability } from "./http.js";
import type { CasAdminErrorResponse } from "./errors.js";
import { CasAdminErrorCodes } from "./errors.js";
import type {
  CasControlAuditEvent,
  CasHash,
  CasMemberInvitation,
  CasOAuthIssuerInspection,
  CasOAuthIssuerInspectionKey,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasPlaygroundFileRoot,
  CasRefChanges,
  CasRefDomain,
  CasRootRefBalance,
  CasRootRefEvent,
  CasStack,
  CasStackMember,
  CasStackOAuthIssuer,
} from "./types.js";

const TimestampSchema = z.number().int().nonnegative()
  .describe("Unix timestamp in milliseconds since 1970-01-01T00:00:00Z.");
const RevisionSchema = z.number().int().nonnegative()
  .describe("Monotonically increasing resource revision used for optimistic concurrency.");
const NonEmptyStringSchema = z.string().min(1);

export const CasHashSchema: z.ZodType<CasHash> = z.string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest")
  .describe("Lowercase hexadecimal SHA-256 digest of canonical CAS node bytes.")
  .meta({ id: "CasAdminHash" });

export const CasRefChangesSchema: z.ZodType<CasRefChanges> =
  z.record(CasHashSchema, z.number().int()).readonly()
    .describe("Signed Root Ref deltas keyed by node digest. Positive values acquire references and negative values release them.")
    .meta({ id: "CasAdminRefChanges" });

export const CasOperatorIdentityKeySchema: z.ZodType<CasOperatorIdentityKey> = z.object({
  identityIssuer: NonEmptyStringSchema.describe("Canonical OIDC issuer that authenticated the operator."),
  subject: NonEmptyStringSchema.describe("Immutable OIDC subject within the identity issuer. Email is never used as the ownership key."),
}).readonly().meta({ id: "CasOperatorIdentityKey" });

export const CasOperatorIdentitySchema: z.ZodType<CasOperatorIdentity> = z.object({
  identityIssuer: NonEmptyStringSchema.describe("Canonical OIDC issuer that authenticated the operator."),
  subject: NonEmptyStringSchema.describe("Immutable subject identifier within the issuer."),
  displayName: z.string().nullable().describe("Best-effort display name from identity claims; not an authorization key."),
  emailForDisplay: z.string().nullable().describe("Best-effort email for UI display; never used to establish ownership."),
}).readonly().meta({ id: "CasOperatorIdentity" });

export const CasStackSchema: z.ZodType<CasStack> = z.object({
  stackId: NonEmptyStringSchema.describe("Opaque UniCAS-generated stack identifier. Callers cannot choose or rename it."),
  displayName: NonEmptyStringSchema.describe("Administrator-visible stack name."),
  description: z.string().describe("Administrator-visible stack description; an empty string means no description."),
  status: z.enum(["active", "suspended"])
    .describe("Operational status. A suspended stack cannot serve normal tenant data-plane traffic."),
  createdAt: TimestampSchema.describe("Time at which UniCAS created the stack."),
  revision: RevisionSchema.describe("Current stack revision. Send this value in `If-Match` for an update."),
}).readonly().meta({ id: "CasStack" });

export const CasStackMemberSchema: z.ZodType<CasStackMember> = z.object({
  stackId: NonEmptyStringSchema.describe("Stack whose equal administrator authority this membership grants."),
  identityIssuer: NonEmptyStringSchema.describe("OIDC issuer component of the immutable membership key."),
  subject: NonEmptyStringSchema.describe("OIDC subject component of the immutable membership key."),
  displayName: z.string().nullable().describe("Display-only identity name captured from authentication claims."),
  emailForDisplay: z.string().nullable().describe("Display-only identity email; it is not an authorization key."),
}).readonly().meta({ id: "CasStackMember" });

export const CasPlaygroundFileRootSchema: z.ZodType<CasPlaygroundFileRoot> = z.object({
  rootId: NonEmptyStringSchema.describe("Playground-owned stable business record identifier."),
  name: NonEmptyStringSchema.describe("Administrator-visible file name."),
  manifestHash: CasHashSchema.describe("CAS manifest retained by this business root."),
  revision: RevisionSchema.describe("Current file-root revision required by conditional updates and deletion."),
  createdAt: TimestampSchema.describe("Time at which the Playground root was created."),
  updatedAt: TimestampSchema.describe("Time of the latest metadata or manifest change."),
}).readonly().meta({ id: "CasPlaygroundFileRoot" });

export const CasMemberInvitationSchema: z.ZodType<CasMemberInvitation> = z.object({
  invitationId: NonEmptyStringSchema.describe("Opaque persistent invitation identity. This is not the bearer acceptance token."),
  stackId: NonEmptyStringSchema.describe("Stack the accepted invitation joins."),
  status: z.enum(["pending", "accepted", "expired", "revoked"])
    .describe("Current single-use invitation lifecycle state."),
  emailConstraint: z.string().nullable()
    .describe("Email the authenticated account must match, or null for an invitation without an email constraint."),
  expiresAt: TimestampSchema.describe("Deadline after which the bearer acceptance token is rejected."),
  createdAt: TimestampSchema.describe("Time at which the invitation was issued."),
  revision: RevisionSchema.describe("Current invitation revision."),
}).readonly().meta({ id: "CasMemberInvitation" });

const OAuthIssuerShape = {
  stackId: NonEmptyStringSchema.describe("Stack whose tenant capabilities this issuer authorizes."),
  mode: z.enum(["managed", "external"]).describe("Whether UniCAS operates the issuer or trusts an administrator-activated external provider."),
  issuer: z.url().describe("Exact canonical issuer identifier required in capability `iss` claims."),
  audience: NonEmptyStringSchema.describe("Exact CAS resource audience required in capability `aud` claims."),
  metadataUrl: z.url().describe("Discovery document URL used to refresh the issuer configuration."),
  metadataType: z.enum(["oauth", "oidc"]).describe("Discovery protocol used by the metadata document."),
  authorizationEndpoint: z.url().describe("Discovered OAuth authorization endpoint."),
  tokenEndpoint: z.url().describe("Discovered OAuth token endpoint."),
  jwksUri: z.url().describe("Discovered public JWKS endpoint used to verify capability signatures."),
  registrationEndpoint: z.url().nullable().describe("Discovered dynamic client registration endpoint, or null when unsupported."),
  scopesSupported: z.array(z.string()).readonly().describe("Scopes advertised by issuer discovery."),
  codeChallengeMethodsSupported: z.array(z.string()).readonly().describe("PKCE challenge methods advertised by issuer discovery."),
};

export const CasStackOAuthIssuerSchema: z.ZodType<CasStackOAuthIssuer> = z.object({
  ...OAuthIssuerShape,
  status: z.enum(["pending", "active", "stale", "incompatible", "disabled"])
    .describe("Current trust state. Only an active issuer authorizes normal tenant capabilities."),
  verifiedAt: TimestampSchema.nullable().describe("Time of the latest successful ownership proof, or null before verification."),
  lastRefreshAt: TimestampSchema.nullable().describe("Time of the latest metadata/JWKS refresh attempt, or null when never refreshed."),
  lastRefreshError: z.string().nullable().describe("Diagnostic message from the latest failed refresh, or null after success."),
  jwksDigest: NonEmptyStringSchema.describe("Digest of the verified public JWKS snapshot."),
  capabilityMaxLifetimeSeconds: z.number().int().positive().describe("Maximum accepted capability lifetime in seconds for this stack."),
  revision: RevisionSchema.describe("Current issuer resource revision required by conditional mutation."),
}).readonly().meta({ id: "CasStackOAuthIssuer" });

export const CasOAuthIssuerInspectionKeySchema: z.ZodType<CasOAuthIssuerInspectionKey> = z.object({
  kid: NonEmptyStringSchema.describe("JWK key identifier advertised by the inspected issuer."),
  algorithm: NonEmptyStringSchema.describe("Supported signature algorithm selected for this public key."),
  publicJwk: z.record(z.string(), z.unknown()).readonly().describe("Public JWK. Private key material is never returned or stored by UniCAS."),
}).readonly().meta({ id: "CasOAuthIssuerInspectionKey" });

export const CasOAuthIssuerInspectionSchema: z.ZodType<CasOAuthIssuerInspection> = z.object({
  inspectionId: NonEmptyStringSchema.describe("Short-lived inspection identity supplied to the activation operation."),
  ...OAuthIssuerShape,
  metadataDigest: NonEmptyStringSchema.describe("Digest of the bounded discovery document inspected by UniCAS."),
  jwksDigest: NonEmptyStringSchema.describe("Digest of the public JWKS inspected by UniCAS."),
  capabilityMaxLifetimeSeconds: z.number().int().positive().describe("Proposed maximum accepted capability lifetime in seconds."),
  challenge: NonEmptyStringSchema.describe("Exact compact-JWS payload bytes that an advertised private key must sign to prove issuer control."),
  expiresAt: TimestampSchema.describe("Deadline for activating this inspection and challenge."),
  keys: z.array(CasOAuthIssuerInspectionKeySchema).readonly().describe("Compatible public verification keys discovered for the issuer."),
  revision: RevisionSchema.describe("Revision of the pending issuer resource created by inspection."),
}).readonly().meta({ id: "CasOAuthIssuerInspection" });

export const CasRefDomainSchema: z.ZodType<CasRefDomain> = z.object({
  stackId: NonEmptyStringSchema.describe("Stack in which this Root Ref domain was observed."),
  refDomain: NonEmptyStringSchema.describe("Business lifecycle namespace taken from signed tenant capabilities."),
  revision: RevisionSchema.describe("Latest observed Root Ref revision for this domain."),
}).readonly().meta({ id: "CasRefDomain" });

export const CasControlAuditEventSchema: z.ZodType<CasControlAuditEvent> = z.object({
  eventId: NonEmptyStringSchema.describe("Opaque append-only audit event identity."),
  stackId: NonEmptyStringSchema.nullable().describe("Affected stack, or null for a platform-scoped event."),
  actor: CasOperatorIdentityKeySchema.describe("Immutable identity key of the operator that caused the event."),
  action: NonEmptyStringSchema.describe("Stable machine-readable control-plane action name."),
  target: NonEmptyStringSchema.describe("Canonical resource identity affected by the action."),
  requestId: z.string().nullable().describe("Request correlation identity when supplied by the ingress path."),
  traceId: z.string().nullable().describe("Distributed trace identity when tracing was active."),
  caller: z.object({
    channel: z.enum(["admin-webui", "mcp"]).describe("Administrator interaction surface that initiated the operation."),
    oauthClientHandle: z.string().nullable().describe("Opaque MCP OAuth client handle, or null for browser UI calls."),
    toolName: z.string().nullable().describe("MCP tool name when the action came through MCP, otherwise null."),
  }).readonly().nullable().describe("Calling client metadata, or null when unavailable."),
  createdAt: TimestampSchema.describe("Time at which the append-only event was recorded."),
}).readonly().meta({ id: "CasControlAuditEvent" });

export const CasRootRefBalanceSchema: z.ZodType<CasRootRefBalance> = z.object({
  tenantId: NonEmptyStringSchema.describe("Tenant that owns this Root Ref balance."),
  hash: CasHashSchema.describe("Node whose business-root balance is reported."),
  count: z.number().int().describe("Current signed balance in the selected refDomain."),
}).readonly().meta({ id: "CasAdminRootRefBalance" });

export const CasRootRefEventSchema: z.ZodType<CasRootRefEvent> = z.object({
  revision: RevisionSchema.describe("Domain-local revision assigned to this atomic Root Ref commit."),
  tenantId: NonEmptyStringSchema.describe("Tenant whose balances were changed."),
  requestId: NonEmptyStringSchema.describe("Stable idempotency identity supplied by the tenant writer."),
  changes: CasRefChangesSchema.describe("Complete atomic set of deltas applied by this event."),
  appliedAt: TimestampSchema.describe("Time at which UniCAS committed the Root Ref update."),
}).readonly().meta({ id: "CasRootRefEvent" });

export const CasManagedCapabilitySchema: z.ZodType<CasManagedCapability> = z.object({
  accessToken: NonEmptyStringSchema.describe("Short-lived bearer capability. Treat as a secret; do not persist it or write it to logs."),
  tokenType: z.literal("Bearer").describe("Authorization scheme used with the access token."),
  expiresIn: z.number().int().positive().describe("Remaining token lifetime in seconds at issuance."),
  expiresAt: TimestampSchema.describe("Absolute capability expiration time."),
  issuer: z.url().describe("Managed issuer in the token's `iss` claim."),
  audience: NonEmptyStringSchema.describe("CAS resource audience in the token's `aud` claim."),
  tenantId: NonEmptyStringSchema.describe("Tenant resource scope embedded in the capability."),
  permissions: z.array(NonEmptyStringSchema).readonly().describe("Exact CAS permission claims granted to the capability."),
}).readonly().meta({ id: "CasManagedCapability" });

export const CasAdminErrorResponseSchema: z.ZodType<CasAdminErrorResponse> = z.object({
  error: z.enum(Object.values(CasAdminErrorCodes)).describe("Stable machine-readable control-plane error code."),
  message: z.string().optional().describe("Optional diagnostic message intended for operators, not programmatic branching."),
}).readonly().meta({ id: "CasAdminErrorResponse" });