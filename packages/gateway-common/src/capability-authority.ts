import type { CasRoute } from "@unidocs/protocol-cas";
import type { DocOperation } from "@unidocs/protocol-doc";
import type {
  CapabilityPermission,
  IssueCapabilityInput,
} from "@unidocs/service-auth";
import {
  casCapabilityPolicy,
  docCapabilityPolicy,
} from "./capability-policy.js";

export interface GatewayCapabilityIssuer {
  readonly keyId: string;
  issue(input: IssueCapabilityInput): Promise<string>;
}

export interface GatewayCapabilityAuditEvent {
  readonly kind: "doc" | "delegated-cas" | "gateway-cas";
  readonly kid: string;
  readonly jti: string;
  readonly subject: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly permissions: readonly CapabilityPermission[];
}

export interface GatewayCapabilityAuthorityConfig {
  readonly issuer: GatewayCapabilityIssuer;
  readonly casAudience: string;
  readonly generateJti?: () => string;
  readonly audit?: (event: GatewayCapabilityAuditEvent) => void;
}

export interface DocOperationCredentials {
  readonly authorization: string;
  readonly delegatedCasCapability?: string;
  readonly deadlineSeconds: 15 | 30 | 60 | 90;
}

export class GatewayCapabilityAuthority {
  readonly #issuer: GatewayCapabilityIssuer;
  readonly #casAudience: string;
  readonly #generateJti: () => string;
  readonly #audit: (event: GatewayCapabilityAuditEvent) => void;

  constructor(config: GatewayCapabilityAuthorityConfig) {
    if (config.issuer.keyId.length === 0) throw new TypeError("Capability key ID is required");
    if (config.casAudience.length === 0) throw new TypeError("CAS capability audience is required");
    this.#issuer = config.issuer;
    this.#casAudience = config.casAudience;
    this.#generateJti = config.generateJti ?? (() => crypto.randomUUID());
    this.#audit = config.audit ?? (() => undefined);
  }

  async issueDocOperation(input: {
    readonly operation: DocOperation;
    readonly docType: string;
    readonly docAudience: string;
    readonly tenantId: string;
    readonly sessionId: string;
  }): Promise<DocOperationCredentials> {
    if (input.docAudience.length === 0) throw new TypeError("Doc capability audience is required");
    const policy = docCapabilityPolicy(input.operation, input.tenantId, input.sessionId);

    let delegatedCasCapability: string | undefined;
    if (policy.delegatedCasPermissions.length > 0) {
      delegatedCasCapability = await this.#issue({
        kind: "delegated-cas",
        subject: `doc:${input.docType}`,
        audience: this.#casAudience,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        permissions: policy.delegatedCasPermissions,
        lifetimeSeconds: policy.lifetimeSeconds,
      });
    }

    const authorization = await this.#issue({
      kind: "doc",
      subject: "gateway",
      audience: input.docAudience,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      permissions: [policy.docPermission],
      lifetimeSeconds: policy.lifetimeSeconds,
    });

    return Object.freeze({
      authorization: `Bearer ${authorization}`,
      ...(delegatedCasCapability === undefined
        ? {}
        : { delegatedCasCapability }),
      deadlineSeconds: policy.deadlineSeconds,
    });
  }

  async issueCasOperation(route: CasRoute): Promise<string> {
    const policy = casCapabilityPolicy(route);
    const token = await this.#issue({
      kind: "gateway-cas",
      subject: "gateway",
      audience: this.#casAudience,
      tenantId: route.tenantId,
      permissions: [policy.permission],
      lifetimeSeconds: policy.lifetimeSeconds,
    });
    return `Bearer ${token}`;
  }

  async #issue(input: {
    readonly kind: GatewayCapabilityAuditEvent["kind"];
    readonly subject: string;
    readonly audience: string;
    readonly tenantId: string;
    readonly sessionId?: string;
    readonly permissions: readonly CapabilityPermission[];
    readonly lifetimeSeconds: number;
  }): Promise<string> {
    const jti = this.#generateJti();
    if (jti.length === 0) throw new TypeError("Capability token ID is required");
    const token = await this.#issuer.issue({
      subject: input.subject,
      audience: input.audience,
      tenantId: input.tenantId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      permissions: input.permissions,
      lifetimeSeconds: input.lifetimeSeconds,
      jti,
    });
    this.#audit(Object.freeze({
      kind: input.kind,
      kid: this.#issuer.keyId,
      jti,
      subject: input.subject,
      audience: input.audience,
      tenantId: input.tenantId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      permissions: Object.freeze([...input.permissions]),
    }));
    return token;
  }
}