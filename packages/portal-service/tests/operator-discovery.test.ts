import { describe, expect, test } from "vitest";
import { OperatorDiscoveryError, validateOperatorDiscovery } from "../src/index.js";

const descriptor = {
  protocol: "unidocs-operator/v1",
  declaredOperatorId: "markdown-primary",
  displayName: "Markdown Operator",
  supportedDocumentTypes: ["markdown"],
  supportedDocumentContracts: { markdown: [0, 2] },
};
const expected = { declaredOperatorId: "markdown-primary", documentType: "markdown", expectedConfigEtag: '"operator-v1"', documentContractIdxs: [0, 1, 2] };

describe("Operator discovery policy", () => {
  test("accepts the registered identity, pinned external ETag and known paired revisions", () => {
    expect(validateOperatorDiscovery(descriptor, '"operator-v1"', expected)).toEqual(descriptor);
    expect(validateOperatorDiscovery(descriptor, null, { ...expected, expectedConfigEtag: null })).toEqual(descriptor);
  });

  test.each([
    { ...descriptor, protocol: "unknown" }, { ...descriptor, declaredOperatorId: "impersonator" },
    { ...descriptor, extra: "not-a-contract-field" },
    { ...descriptor, supportedDocumentTypes: ["psd"] },
    { ...descriptor, supportedDocumentTypes: ["markdown", "markdown"] },
    { ...descriptor, supportedDocumentTypes: ["markdown", "psd"] },
    { ...descriptor, supportedDocumentContracts: { markdown: [0], psd: [0] } },
    { ...descriptor, supportedDocumentContracts: { markdown: [0, 0] } },
    { ...descriptor, supportedDocumentContracts: { markdown: [3] } },
    { ...descriptor, supportedDocumentContracts: { markdown: [] } },
    { ...descriptor, supportedDocumentContracts: { markdown: [-1] } },
    { ...descriptor, supportedDocumentContracts: { markdown: [1.5] } },
    { ...descriptor, supportedDocumentContracts: { markdown: ["0"] } },
    null,
  ])("rejects incompatible descriptor %#", value => {
    expect(() => validateOperatorDiscovery(value, '"operator-v1"', expected)).toThrow(OperatorDiscoveryError);
  });

  test.each([null, '"operator-v2"', 'W/"operator-v1"', "operator-v1"])("rejects missing, stale or weak pinned ETag %j", etag => {
    expect(() => validateOperatorDiscovery(descriptor, etag, expected)).toThrow(OperatorDiscoveryError);
  });

  test("requires an existing contract even when the registration has none", () => {
    expect(() => validateOperatorDiscovery(descriptor, '"operator-v1"', { ...expected, documentContractIdxs: [] })).toThrow(OperatorDiscoveryError);
  });

  test("preserves other advertised types without pretending their revisions were validated", () => {
    const multiType = { ...descriptor, supportedDocumentTypes: ["markdown", "psd"], supportedDocumentContracts: { markdown: [0], psd: [99] } };
    expect(validateOperatorDiscovery(multiType, '"operator-v1"', expected)).toEqual(multiType);
    expect(() => validateOperatorDiscovery(multiType, '"operator-v1"', { ...expected, documentType: "psd", documentContractIdxs: [0] })).toThrow(OperatorDiscoveryError);
  });
});