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

const TimestampSchema = z.number().int().nonnegative();
const RevisionSchema = z.number().int().nonnegative();
const NonEmptyStringSchema = z.string().min(1);

export const CasHashSchema: z.ZodType<CasHash> = z.string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest")
  .meta({ id: "CasAdminHash" });

export const CasRefChangesSchema: z.ZodType<CasRefChanges> =
  z.record(CasHashSchema, z.number().int()).readonly().meta({ id: "CasAdminRefChanges" });

export const CasOperatorIdentityKeySchema: z.ZodType<CasOperatorIdentityKey> = z.object({
  identityIssuer: NonEmptyStringSchema,
  subject: NonEmptyStringSchema,
}).readonly().meta({ id: "CasOperatorIdentityKey" });

export const CasOperatorIdentitySchema: z.ZodType<CasOperatorIdentity> = z.object({
  identityIssuer: NonEmptyStringSchema,
  subject: NonEmptyStringSchema,
  displayName: z.string().nullable(),
  emailForDisplay: z.string().nullable(),
}).readonly().meta({ id: "CasOperatorIdentity" });

export const CasStackSchema: z.ZodType<CasStack> = z.object({
  stackId: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  description: z.string(),
  status: z.enum(["active", "suspended"]),
  createdAt: TimestampSchema,
  revision: RevisionSchema,
}).readonly().meta({ id: "CasStack" });

export const CasStackMemberSchema: z.ZodType<CasStackMember> = z.object({
  stackId: NonEmptyStringSchema,
  identityIssuer: NonEmptyStringSchema,
  subject: NonEmptyStringSchema,
  displayName: z.string().nullable(),
  emailForDisplay: z.string().nullable(),
}).readonly().meta({ id: "CasStackMember" });

export const CasPlaygroundFileRootSchema: z.ZodType<CasPlaygroundFileRoot> = z.object({
  rootId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  manifestHash: CasHashSchema,
  revision: RevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).readonly().meta({ id: "CasPlaygroundFileRoot" });

export const CasMemberInvitationSchema: z.ZodType<CasMemberInvitation> = z.object({
  invitationId: NonEmptyStringSchema,
  stackId: NonEmptyStringSchema,
  status: z.enum(["pending", "accepted", "expired", "revoked"]),
  emailConstraint: z.string().nullable(),
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  revision: RevisionSchema,
}).readonly().meta({ id: "CasMemberInvitation" });

const OAuthIssuerShape = {
  stackId: NonEmptyStringSchema,
  mode: z.enum(["managed", "external"]),
  issuer: z.url(),
  audience: NonEmptyStringSchema,
  metadataUrl: z.url(),
  metadataType: z.enum(["oauth", "oidc"]),
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  jwksUri: z.url(),
  registrationEndpoint: z.url().nullable(),
  scopesSupported: z.array(z.string()).readonly(),
  codeChallengeMethodsSupported: z.array(z.string()).readonly(),
};

export const CasStackOAuthIssuerSchema: z.ZodType<CasStackOAuthIssuer> = z.object({
  ...OAuthIssuerShape,
  status: z.enum(["pending", "active", "stale", "incompatible", "disabled"]),
  verifiedAt: TimestampSchema.nullable(),
  lastRefreshAt: TimestampSchema.nullable(),
  lastRefreshError: z.string().nullable(),
  jwksDigest: NonEmptyStringSchema,
  capabilityMaxLifetimeSeconds: z.number().int().positive(),
  revision: RevisionSchema,
}).readonly().meta({ id: "CasStackOAuthIssuer" });

export const CasOAuthIssuerInspectionKeySchema: z.ZodType<CasOAuthIssuerInspectionKey> = z.object({
  kid: NonEmptyStringSchema,
  algorithm: NonEmptyStringSchema,
  publicJwk: z.record(z.string(), z.unknown()).readonly(),
}).readonly().meta({ id: "CasOAuthIssuerInspectionKey" });

export const CasOAuthIssuerInspectionSchema: z.ZodType<CasOAuthIssuerInspection> = z.object({
  inspectionId: NonEmptyStringSchema,
  ...OAuthIssuerShape,
  metadataDigest: NonEmptyStringSchema,
  jwksDigest: NonEmptyStringSchema,
  capabilityMaxLifetimeSeconds: z.number().int().positive(),
  challenge: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  keys: z.array(CasOAuthIssuerInspectionKeySchema).readonly(),
  revision: RevisionSchema,
}).readonly().meta({ id: "CasOAuthIssuerInspection" });

export const CasRefDomainSchema: z.ZodType<CasRefDomain> = z.object({
  stackId: NonEmptyStringSchema,
  refDomain: NonEmptyStringSchema,
  revision: RevisionSchema,
}).readonly().meta({ id: "CasRefDomain" });

export const CasControlAuditEventSchema: z.ZodType<CasControlAuditEvent> = z.object({
  eventId: NonEmptyStringSchema,
  stackId: NonEmptyStringSchema.nullable(),
  actor: CasOperatorIdentityKeySchema,
  action: NonEmptyStringSchema,
  target: NonEmptyStringSchema,
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  caller: z.object({
    channel: z.enum(["admin-webui", "mcp"]),
    oauthClientHandle: z.string().nullable(),
    toolName: z.string().nullable(),
  }).readonly().nullable(),
  createdAt: TimestampSchema,
}).readonly().meta({ id: "CasControlAuditEvent" });

export const CasRootRefBalanceSchema: z.ZodType<CasRootRefBalance> = z.object({
  tenantId: NonEmptyStringSchema,
  hash: CasHashSchema,
  count: z.number().int(),
}).readonly().meta({ id: "CasAdminRootRefBalance" });

export const CasRootRefEventSchema: z.ZodType<CasRootRefEvent> = z.object({
  revision: RevisionSchema,
  tenantId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  changes: CasRefChangesSchema,
  appliedAt: TimestampSchema,
}).readonly().meta({ id: "CasRootRefEvent" });

export const CasManagedCapabilitySchema: z.ZodType<CasManagedCapability> = z.object({
  accessToken: NonEmptyStringSchema,
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  expiresAt: TimestampSchema,
  issuer: z.url(),
  audience: NonEmptyStringSchema,
  tenantId: NonEmptyStringSchema,
  permissions: z.array(NonEmptyStringSchema).readonly(),
}).readonly().meta({ id: "CasManagedCapability" });

export const CasAdminErrorResponseSchema: z.ZodType<CasAdminErrorResponse> = z.object({
  error: z.enum(Object.values(CasAdminErrorCodes)),
  message: z.string().optional(),
}).readonly().meta({ id: "CasAdminErrorResponse" });