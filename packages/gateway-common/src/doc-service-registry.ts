import type { DocServiceRegistration } from "./gateway-handler.js";

export class StaticDocServiceRegistry {
  readonly #byDocType: ReadonlyMap<string, DocServiceRegistration>;

  constructor(serialized: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (err) {
      throw new Error(`DOC_SERVICES_JSON is not valid JSON: ${String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("DOC_SERVICES_JSON must be an object keyed by docType");
    }

    const byDocType = new Map<string, DocServiceRegistration>();
    const serviceIds = new Set<string>();
    for (const [docType, value] of Object.entries(parsed)) {
      if (!/^[a-z][a-z0-9-]*$/.test(docType)) {
        throw new TypeError(`Invalid document type registration: ${docType}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`Registration ${docType} must be an object`);
      }
      const candidate = value as Record<string, unknown>;
      const serviceId = candidate.serviceId;
      const url = candidate.url;
      const accessKey = candidate.accessKey;
      if (typeof serviceId !== "string" || serviceId.length === 0) {
        throw new TypeError(`Registration ${docType} has no serviceId`);
      }
      if (serviceIds.has(serviceId)) {
        throw new TypeError(`Duplicate Doc serviceId: ${serviceId}`);
      }
      if (typeof url !== "string") {
        throw new TypeError(`Registration ${docType} has no URL`);
      }
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new TypeError(`Registration ${docType} URL must use HTTP(S)`);
      }
      if (typeof accessKey !== "string" || accessKey.length === 0) {
        throw new TypeError(`Registration ${docType} has no accessKey`);
      }
      serviceIds.add(serviceId);
      byDocType.set(docType, Object.freeze({
        serviceId,
        url: parsedUrl.toString().replace(/\/$/, ""),
        accessKey,
      }));
    }
    this.#byDocType = byDocType;
  }

  resolve(docType: string): Promise<DocServiceRegistration | null> {
    return Promise.resolve(this.#byDocType.get(docType) ?? null);
  }
}