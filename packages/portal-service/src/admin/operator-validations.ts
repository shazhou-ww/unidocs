import {
  CreateOperatorValidationRequestSchema,
  OperatorDescriptorSchema,
  OperatorValidationSchema,
  type CreateOperatorValidationRequest,
  type OperatorValidation,
} from "@unidocs/protocol-admin-portal";
import type { AdminContext } from "../auth/administrator.js";
import { canonicalJson, schemaHash } from "../identity.js";
import { validateOperatorDiscovery } from "../operators/discovery.js";
import { createOperatorProbeRequest, verifyOperatorProbeReceipt } from "../operators/probe.js";
import { parseStrictJson } from "../strict-json.js";

export type OperatorValidationErrorCode = "invalid_request" | "not_found" | "idempotency_conflict" | "forbidden" | "operator_validation_failed";

export class OperatorValidationOperationError extends Error {
  constructor(readonly code: OperatorValidationErrorCode) {
    super({
      invalid_request: "The request is invalid",
      not_found: "Document type or validation not found",
      idempotency_conflict: "The idempotency key was used with a different request",
      forbidden: "Administrator access is denied",
      operator_validation_failed: "The Operator could not be validated",
    }[code]);
    this.name = "OperatorValidationOperationError";
  }
}

export interface OperatorValidationTransportResponse {
  readonly body: Uint8Array;
  readonly etag: string | null;
  readonly proofHeaders: Readonly<Record<string, string>>;
}

export interface OperatorValidationTransport {
  discovery(baseUrl: string): Promise<OperatorValidationTransportResponse>;
  probe(baseUrl: string, body: Uint8Array, proofHeaders: Readonly<Record<string, string>>): Promise<OperatorValidationTransportResponse>;
}

export interface OperatorValidationKeyResolver {
  resolve(baseUrl: string): Promise<Uint8Array | null>;
}

export interface OperatorValidationPublishCommand {
  readonly context: AdminContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly validation: OperatorValidation;
  readonly requestId: string;
  readonly auditEventId: string;
}

export interface OperatorValidationFailureCommand {
  readonly context: AdminContext;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly documentType: string;
  readonly occurredAt: string;
  readonly phase: "discovery" | "probe";
}

export interface OperatorValidationRepository {
  replay(context: AdminContext, key: string, fingerprint: string): Promise<OperatorValidation | null>;
  listDocumentContractIdxs(context: AdminContext, documentType: string): Promise<readonly number[] | null>;
  publish(command: OperatorValidationPublishCommand): Promise<OperatorValidation>;
  recordFailure(command: OperatorValidationFailureCommand): Promise<void>;
  get(context: AdminContext, validationId: string, now: string): Promise<OperatorValidation | null>;
}

function validKey(key: string) {
  return /^[\x21-\x7e]{1,128}$/.test(key);
}

function canonicalBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || /[%\\\s]/.test(value)) throw new Error();
  const canonical = url.href.replace(/\/$/, "");
  if (value !== canonical || url.hostname.endsWith(".") || !/^[a-z0-9.-]+$/.test(url.hostname)) throw new Error();
  return canonical;
}

export function createOperatorValidationService(
  repository: OperatorValidationRepository,
  transport: OperatorValidationTransport,
  keys: OperatorValidationKeyResolver,
  options: {
    readonly now?: () => Date;
    readonly id?: () => string;
    readonly challenge?: () => Uint8Array;
    readonly probeTtlSeconds?: number;
    readonly validationTtlSeconds?: number;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  const challenge = options.challenge ?? (() => crypto.getRandomValues(new Uint8Array(32)));
  const probeTtlSeconds = options.probeTtlSeconds ?? 60;
  const validationTtlSeconds = options.validationTtlSeconds ?? 900;
  if (!Number.isSafeInteger(probeTtlSeconds) || probeTtlSeconds < 1 || probeTtlSeconds > 300
    || !Number.isSafeInteger(validationTtlSeconds) || validationTtlSeconds < 1 || validationTtlSeconds > 3_600) throw new RangeError("Invalid Operator validation TTL");

  return {
    async validate(context: AdminContext, body: unknown, key: string, requestId: string): Promise<OperatorValidation> {
      const parsed = CreateOperatorValidationRequestSchema.safeParse(body);
      let request: CreateOperatorValidationRequest;
      let baseUrl: string;
      try {
        if (!parsed.success || typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some(field => !["baseUrl", "expectedDocumentType", "expectedConfigEtag"].includes(field)) || !validKey(key)) throw new Error();
        request = parsed.data;
        baseUrl = canonicalBaseUrl(request.baseUrl);
      } catch {
        throw new OperatorValidationOperationError("invalid_request");
      }
      const fingerprint = await schemaHash({ operation: "createOperatorValidation", baseUrl, expectedDocumentType: request.expectedDocumentType, expectedConfigEtag: request.expectedConfigEtag });
      const replayed = await repository.replay(context, key, fingerprint);
      if (replayed) return replayed;
      const occurredAtDate = new Date(Math.floor(now().getTime() / 1000) * 1000);
      const occurredAt = occurredAtDate.toISOString();
      let phase: "discovery" | "probe" = "discovery";
      let validation: OperatorValidation;
      try {
        const [keyBytes, documentContractIdxs] = await Promise.all([
          keys.resolve(baseUrl),
          repository.listDocumentContractIdxs(context, request.expectedDocumentType),
        ]);
        if (!keyBytes || documentContractIdxs === null) {
          if (documentContractIdxs === null) throw new OperatorValidationOperationError("not_found");
          throw new Error();
        }
        const discovery = await transport.discovery(baseUrl);
        const discoveryValue = parseStrictJson(discovery.body);
        const discovered = OperatorDescriptorSchema.parse(discoveryValue);
        const descriptor = validateOperatorDiscovery(discoveryValue, discovery.etag, {
          declaredOperatorId: discovered.declaredOperatorId,
          documentType: request.expectedDocumentType,
          expectedConfigEtag: request.expectedConfigEtag,
          documentContractIdxs,
        });
        phase = "probe";
        const probe = await createOperatorProbeRequest({
          challenge: challenge(),
          declaredOperatorId: descriptor.declaredOperatorId,
          documentType: request.expectedDocumentType,
          configEtag: discovery.etag,
          issuedAt: occurredAtDate,
          ttlSeconds: probeTtlSeconds,
          keyBytes,
        });
        const probeResponse = await transport.probe(baseUrl, new TextEncoder().encode(canonicalJson(probe.body)), { "x-unidocs-probe-signature": probe.signature });
        const receiptValue = parseStrictJson(probeResponse.body);
        const signature = probeResponse.proofHeaders["x-unidocs-probe-signature"];
        if (!signature) throw new Error();
        await verifyOperatorProbeReceipt(receiptValue, signature, probe.body, keyBytes, occurredAtDate);
        validation = OperatorValidationSchema.parse({
          validationId: id(),
          documentType: request.expectedDocumentType,
          baseUrl,
          expectedConfigEtag: discovery.etag,
          descriptor,
          validatedAt: occurredAt,
          expiresAt: new Date(occurredAtDate.getTime() + validationTtlSeconds * 1000).toISOString(),
        });
      } catch (error) {
        if (error instanceof OperatorValidationOperationError && error.code !== "operator_validation_failed") throw error;
        await repository.recordFailure({ context, requestId, auditEventId: id(), documentType: request.expectedDocumentType, occurredAt, phase });
        throw new OperatorValidationOperationError("operator_validation_failed");
      }
      return repository.publish({ context, key, fingerprint, validation, requestId, auditEventId: id() });
    },
    async get(context: AdminContext, validationId: string): Promise<OperatorValidation> {
      if (!/^[A-Za-z0-9!$&^_.+-]{1,256}$/.test(validationId)) throw new OperatorValidationOperationError("invalid_request");
      const record = await repository.get(context, validationId, new Date(Math.floor(now().getTime() / 1000) * 1000).toISOString());
      if (!record) throw new OperatorValidationOperationError("not_found");
      return record;
    },
  };
}