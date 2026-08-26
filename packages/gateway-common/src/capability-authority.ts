import type { CasRoute } from "@unicas/protocol-legacy";
import type { DocOperation } from "@unidocs/protocol-doc";
import type {
  CapabilityPermission,
  IssueCapabilityInput,
} from "@unidocs/service-auth";
import {
  casGcTriggerPermission,
  casUsageReadPermission,
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
  readonly refDomain?: string;
  readonly permissions: readonly CapabilityPermission[];
}

export interface GatewayCapabilityAuthorityConfig {
  /** Doc-service identity: signs the doc capabilities (audience unidocs-doc:*). */
  readonly issuer: GatewayCapabilityIssuer;
  /**
   * Stack CAS identity: signs delegated-cas and gateway-cas capabilities in
   * stack mode. When absent, `issuer` is used (legacy/dual/capability modes).
   */
  readonly casIssuer?: GatewayCapabilityIssuer;
  readonly casAudience: string;
  /** Stack namespace for the canonical CAS route prefix (stack mode only). */
  readonly casStackId?: string;
  /** refDomain claim carried by CAS capabilities (stack mode only). */
  readonly casRefDomain?: string;
  readonly generateJti?: () => string;
  readonly audit?: (event: GatewayCapabilityAuditEvent) => void;
}

export interface DocOperationCredentials {
  readonly authorization: string;
  readonly delegatedCasCapability?: string;
  readonly deadlineSeconds: 15 | 30 | 60 | 90;
}

/** Stack-mode permission mapping: usage/gc use the stack-scoped names. */
function stackPermissionFor(route: CasRoute, fallback: CapabilityPermission): CapabilityPermission {
  switch (route.operation) {
    case "usage":
      return casUsageReadPermission(route.tenantId);
    case "gc":
      return casGcTriggerPermission(route.tenantId);
    default:
      return fallback;
  }
}

export class GatewayCapabilityAuthority {
  readonly #issuer: GatewayCapabilityIssuer;
  readonly #casIssuer: GatewayCapabilityIssuer;
  readonly #casAudience: string;
  readonly #casStackId?: string;
  readonly #casRefDomain?: string;
  readonly #generateJti: () => string;
  readonly #audit: (event: GatewayCapabilityAuditEvent) => void;

  constructor(config: GatewayCapabilityAuthorityConfig) {
    if (config.issuer.keyId.length === 0) throw new TypeError("Capability key ID is required");
    if (config.casAudience.length === 0) throw new TypeError("CAS capability audience is required");
    this.#issuer = config.issuer;
    this.#casIssuer = config.casIssuer ?? config.issuer;
    this.#casAudience = config.casAudience;
    this.#casStackId = config.casStackId;
    this.#casRefDomain = config.casRefDomain;
    this.#generateJti = config.generateJti ?? (() => crypto.randomUUID());
    this.#audit = config.audit ?? (() => undefined);
  }

  /** Stack namespace when stack mode is configured; undefined in legacy modes. */
  get stackId(): string | undefined {
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

  async issueCasOperation(route: CasRoute): Promise<string> {
    const policy = casCapabilityPolicy(route);
    // Stack mode talks to the canonical middleware, which requires the
    // stack-scoped permission names (cas:usage / cas:gc) rather than the
    // retired cas:admin.
    const permission = this.#casStackId !== undefined
      ? stackPermissionFor(route, policy.permission)
      : policy.permission;
    const token = await this.#issue(this.#casIssuer, {
      kind: "gateway-cas",
      subject: "gateway",
      audience: this.#casAudience,
      tenantId: route.tenantId,
      refDomain: this.#casRefDomain,
      permissions: [permission],
      lifetimeSeconds: policy.lifetimeSeconds,
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