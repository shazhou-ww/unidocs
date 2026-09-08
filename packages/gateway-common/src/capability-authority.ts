import type { GatewayCasRoute } from "@unidocs/protocol-gateway";
import type { DocOperation } from "@unidocs/protocol-doc";
import type {
  CapabilityPermission,
  IssueCapabilityInput,
} from "@unidocs/service-auth";
import { casReadPermission, casWritePermission } from "@unidocs/service-auth";
import {
  casCapabilityPolicy,
  docCapabilityPolicy,
} from "./capability-policy.js";

export interface GatewayCapabilityIssuer {
  readonly keyId: string;
  issue(input: IssueCapabilityInput): Promise<string>;
}

export interface GatewayCapabilityAuditEvent {
  readonly kind: "doc" | "delegated-cas" | "gateway-cas" | "platform-cas" | "platform-compute-cas";
  readonly kid: string;
  readonly jti: string;
  readonly subject: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly refDomain?: string;
  readonly permissions: readonly CapabilityPermission[];
}

export interface GatewayCapabilityAuthorityConfig {
  /** Doc-service identity: signs the doc capabilities (audience unidocs-doc:*). */
  readonly issuer: GatewayCapabilityIssuer;
  /** Stack CAS identity: signs delegated-cas and gateway-cas capabilities. */
  readonly casIssuer: GatewayCapabilityIssuer;
  readonly casAudience: string;
  readonly casStackId: string;
  /** refDomain claim carried by CAS capabilities. */
  readonly casRefDomain?: string;
  /** Dedicated refDomain for platform-owned immutable document versions. */
  readonly platformCasRefDomain?: string;
  readonly generateJti?: () => string;
  readonly audit?: (event: GatewayCapabilityAuditEvent) => void;
}

export interface DocOperationCredentials {
  readonly authorization: string;
  readonly delegatedCasCapability?: string;
  readonly deadlineSeconds: 15 | 30 | 60 | 90 | 240 | 1800;
}

export class GatewayCapabilityAuthority {
  readonly #issuer: GatewayCapabilityIssuer;
  readonly #casIssuer: GatewayCapabilityIssuer;
  readonly #casAudience: string;
  readonly #casStackId: string;
  readonly #casRefDomain?: string;
  readonly #platformCasRefDomain?: string;
  readonly #generateJti: () => string;
  readonly #audit: (event: GatewayCapabilityAuditEvent) => void;

  constructor(config: GatewayCapabilityAuthorityConfig) {
    if (config.issuer.keyId.length === 0) throw new TypeError("Capability key ID is required");
    if (config.casIssuer.keyId.length === 0) throw new TypeError("CAS capability key ID is required");
    if (config.casAudience.length === 0) throw new TypeError("CAS capability audience is required");
    if (config.casStackId.length === 0) throw new TypeError("CAS stack ID is required");
    this.#issuer = config.issuer;
    this.#casIssuer = config.casIssuer;
    this.#casAudience = config.casAudience;
    this.#casStackId = config.casStackId;
    this.#casRefDomain = config.casRefDomain;
    this.#platformCasRefDomain = config.platformCasRefDomain;
    this.#generateJti = config.generateJti ?? (() => crypto.randomUUID());
    this.#audit = config.audit ?? (() => undefined);
  }

  get stackId(): string {
    return this.#casStackId;
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
      delegatedCasCapability = await this.#issue(this.#casIssuer, {
        kind: "delegated-cas",
        subject: `doc:${input.docType}`,
        audience: this.#casAudience,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        refDomain: this.#casRefDomain,
        permissions: policy.delegatedCasPermissions,
        lifetimeSeconds: policy.lifetimeSeconds,
      });
    }

    const authorization = await this.#issue(this.#issuer, {
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

  async issueCasOperation(route: GatewayCasRoute): Promise<string> {
    const policy = casCapabilityPolicy(route);
    const token = await this.#issue(this.#casIssuer, {
      kind: "gateway-cas",
      subject: "gateway",
      audience: this.#casAudience,
      tenantId: route.tenantId,
      refDomain: this.#casRefDomain,
      permissions: [policy.permission],
      lifetimeSeconds: policy.lifetimeSeconds,
    });
    return `Bearer ${token}`;
  }

  async issuePlatformRootRetention(tenantId: string): Promise<string> {
    if (!this.#platformCasRefDomain) throw new Error("Platform CAS ref domain is required");
    const token = await this.#issue(this.#casIssuer, {
      kind: "platform-cas",
      subject: "platform",
      audience: this.#casAudience,
      tenantId,
      refDomain: this.#platformCasRefDomain,
      // UniCAS currently groups lease and updateRootRefs under cas:write.
      // The dedicated subject/refDomain narrows this token until refs gets its own permission.
      permissions: [casWritePermission(tenantId)],
      lifetimeSeconds: 120,
    });
    return `Bearer ${token}`;
  }

  async issuePlatformComputeCas(input: {
    readonly tenantId: string;
    readonly docType: string;
    readonly mode: "ro" | "rw";
  }): Promise<string> {
    if (input.docType.length === 0) throw new TypeError("Compute document type is required");
    const read = casReadPermission(input.tenantId);
    const token = await this.#issue(this.#casIssuer, {
      kind: "platform-compute-cas",
      subject: `doc:${input.docType}`,
      audience: this.#casAudience,
      tenantId: input.tenantId,
      permissions: input.mode === "ro" ? [read] : [read, casWritePermission(input.tenantId)],
      lifetimeSeconds: 120,
    });
    return `Bearer ${token}`;
  }

  async #issue(
    issuer: GatewayCapabilityIssuer,
    input: {
      readonly kind: GatewayCapabilityAuditEvent["kind"];
      readonly subject: string;
      readonly audience: string;
      readonly tenantId: string;
      readonly sessionId?: string;
      readonly refDomain?: string;
      readonly permissions: readonly CapabilityPermission[];
      readonly lifetimeSeconds: number;
    },
  ): Promise<string> {
    const jti = this.#generateJti();
    if (jti.length === 0) throw new TypeError("Capability token ID is required");
    const token = await issuer.issue({
      subject: input.subject,
      audience: input.audience,
      tenantId: input.tenantId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.refDomain === undefined ? {} : { refDomain: input.refDomain }),
      permissions: input.permissions,
      lifetimeSeconds: input.lifetimeSeconds,
      jti,
    });
    this.#audit(Object.freeze({
      kind: input.kind,
      kid: issuer.keyId,
      jti,
      subject: input.subject,
      audience: input.audience,
      tenantId: input.tenantId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.refDomain === undefined ? {} : { refDomain: input.refDomain }),
      permissions: Object.freeze([...input.permissions]),
    }));
    return token;
  }
}