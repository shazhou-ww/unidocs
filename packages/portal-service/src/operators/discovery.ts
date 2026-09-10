import { ExternalEtagSchema, OperatorDescriptorSchema, type OperatorDescriptor } from "@unidocs/protocol-admin-portal";
import { canonicalJson } from "../identity.js";

export class OperatorDiscoveryError extends Error {
  constructor() {
    super("Operator discovery does not match the registered target or document contracts");
    this.name = "OperatorDiscoveryError";
  }
}

export function validateOperatorDiscovery(
  value: unknown,
  configEtag: string | null,
  expected: {
    readonly declaredOperatorId: string;
    readonly documentType: string;
    readonly expectedConfigEtag: string | null;
    readonly documentContractIdxs: readonly number[];
  },
): OperatorDescriptor {
  try {
    const descriptor = OperatorDescriptorSchema.parse(value);
    if (canonicalJson(value) !== canonicalJson(descriptor) || descriptor.declaredOperatorId !== expected.declaredOperatorId) throw new OperatorDiscoveryError();
    if (configEtag !== null) ExternalEtagSchema.parse(configEtag);
    if (expected.expectedConfigEtag !== null) {
      ExternalEtagSchema.parse(expected.expectedConfigEtag);
      if (configEtag !== expected.expectedConfigEtag) throw new OperatorDiscoveryError();
    }
    const types = new Set(descriptor.supportedDocumentTypes);
    if (types.size !== descriptor.supportedDocumentTypes.length || !types.has(expected.documentType)) throw new OperatorDiscoveryError();
    if (Object.keys(descriptor.supportedDocumentContracts).length !== types.size) throw new OperatorDiscoveryError();
    for (const type of types) {
      if (!Object.hasOwn(descriptor.supportedDocumentContracts, type)) throw new OperatorDiscoveryError();
      const revisions = descriptor.supportedDocumentContracts[type];
      if (new Set(revisions).size !== revisions.length) throw new OperatorDiscoveryError();
    }
    const available = new Set(expected.documentContractIdxs);
    if (descriptor.supportedDocumentContracts[expected.documentType].some(revision => !available.has(revision))) throw new OperatorDiscoveryError();
    return descriptor;
  } catch {
    throw new OperatorDiscoveryError();
  }
}