import { describe, expect, test, vi } from "vitest";
import {
  createOperatorValidationService,
  parseStrictJson,
  signOperatorProbeReceipt,
  type OperatorValidationRepository,
  type OperatorValidationTransport,
} from "../src/index.js";
import type { OperatorDescriptor } from "@unidocs/protocol-admin-portal";

const context = { memberId: "adm_1", identity: { issuer: "issuer", subject: "subject", email: "admin@example.com", authenticatedAt: 1 }, transport: "bearer" as const };
const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const descriptor: OperatorDescriptor = {
  protocol: "unidocs-operator/v1", declaredOperatorId: "markdown-primary", displayName: "Markdown Operator",
  supportedDocumentTypes: ["markdown"], supportedDocumentContracts: { markdown: [0] },
};

function fixture(options: { invalidReceipt?: boolean; replay?: boolean } = {}) {
  const published: unknown[] = [];
  const failures: unknown[] = [];
  let probeRequest: any;
  const transport: OperatorValidationTransport = {
    discovery: vi.fn(async () => ({ body: new TextEncoder().encode(JSON.stringify(descriptor)), etag: '"operator-v1"', proofHeaders: {} })),
    probe: vi.fn(async (_baseUrl, body, headers) => {
      probeRequest = parseStrictJson(body);
      const receipt = {
        protocol: "unidocs-operator-probe-receipt/v1" as const,
        challenge: options.invalidReceipt ? "wrong" : probeRequest.challenge,
        declaredOperatorId: probeRequest.declaredOperatorId,
        documentType: probeRequest.documentType,
        configEtag: probeRequest.configEtag,
        issuedAt: probeRequest.issuedAt,
        expiresAt: probeRequest.expiresAt,
      };
      return { body: new TextEncoder().encode(JSON.stringify(receipt)), etag: null, proofHeaders: { "x-unidocs-probe-signature": await signOperatorProbeReceipt(receipt, keyBytes) } };
    }),
  };
  const replay = {
    validationId: "validation-replay", documentType: "markdown", baseUrl: "https://operator.test", expectedConfigEtag: '"operator-v1"', descriptor,
    validatedAt: "2026-09-11T12:00:00.000Z", expiresAt: "2026-09-11T12:15:00.000Z",
  };
  const repository: OperatorValidationRepository = {
    replay: vi.fn(async () => options.replay ? replay : null),
    listDocumentContractIdxs: vi.fn(async () => [0]),
    publish: vi.fn(async command => { published.push(command); return command.validation; }),
    recordFailure: vi.fn(async command => { failures.push(command); }),
    get: vi.fn(async () => null),
  };
  const service = createOperatorValidationService(repository, transport, { resolve: async () => keyBytes }, {
    now: () => new Date("2026-09-11T12:00:00.987Z"), id: () => "validation-1", challenge: () => new Uint8Array(32).fill(7),
  });
  return { failures, probeRequest: () => probeRequest, published, repository, service, transport };
}

describe("Operator validation service", () => {
  test("validates discovery and signed probe before atomically publishing a short-lived record", async () => {
    const { failures, probeRequest, published, service, transport } = fixture();
    const result = await service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "markdown", expectedConfigEtag: null }, "key-1", "request-1");
    expect(result).toMatchObject({
      validationId: "validation-1", documentType: "markdown", baseUrl: "https://operator.test", expectedConfigEtag: '"operator-v1"', descriptor,
      validatedAt: "2026-09-11T12:00:00.000Z", expiresAt: "2026-09-11T12:15:00.000Z",
    });
    expect(probeRequest()).toMatchObject({ declaredOperatorId: "markdown-primary", documentType: "markdown", configEtag: '"operator-v1"' });
    expect(vi.mocked(transport.probe).mock.calls[0][2]["x-unidocs-probe-signature"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(published).toHaveLength(1);
    expect(failures).toHaveLength(0);
  });

  test("returns an idempotency replay before discovery or probe I/O", async () => {
    const { service, transport } = fixture({ replay: true });
    expect((await service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "markdown", expectedConfigEtag: null }, "key-1", "request-1")).validationId).toBe("validation-replay");
    expect(transport.discovery).not.toHaveBeenCalled();
    expect(transport.probe).not.toHaveBeenCalled();
  });

  test("records a bounded failure audit and never publishes an invalid receipt", async () => {
    const { failures, published, service } = fixture({ invalidReceipt: true });
    await expect(service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "markdown", expectedConfigEtag: null }, "key-1", "request-1"))
      .rejects.toMatchObject({ code: "operator_validation_failed" });
    expect(published).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ requestId: "request-1", documentType: "markdown", phase: "probe" });
  });

  test("does not misreport a persistence failure as an Operator validation failure", async () => {
    const { failures, repository, service } = fixture();
    vi.mocked(repository.publish).mockRejectedValue(new Error("database unavailable"));
    await expect(service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "markdown", expectedConfigEtag: null }, "key-1", "request-1"))
      .rejects.toThrow("database unavailable");
    expect(failures).toHaveLength(0);
  });
});