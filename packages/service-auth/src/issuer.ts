import { SignJWT } from "jose";
import type { JWTPayload, KeyInput } from "jose";
import {
  CapabilityAlgorithm,
  DefaultCapabilityLifetimeSeconds,
  MaximumCapabilityClockSkewSeconds,
  MaximumCapabilityLifetimeSeconds,
  CapabilityTokenType,
  CapabilityVersion,
} from "./claims.js";
import type {
  CapabilityClaims,
  CapabilityProtectedHeader,
} from "./claims.js";
import type { CapabilityPermission } from "./permissions.js";
import { parseCapabilityPermission } from "./permissions.js";

export interface CapabilitySigner {
  readonly algorithm: typeof CapabilityAlgorithm;
  readonly kid: string;
  sign(
    claims: CapabilityClaims,
    protectedHeader: CapabilityProtectedHeader,
  ): Promise<string>;
}

export class JoseCapabilitySigner implements CapabilitySigner {
  readonly algorithm = CapabilityAlgorithm;
  readonly kid: string;
  readonly #key: KeyInput;

  constructor(key: KeyInput, kid: string) {
    requireNonEmpty(kid, "Signing key ID");
    this.#key = key;
    this.kid = kid;
  }

  sign(
    claims: CapabilityClaims,
    protectedHeader: CapabilityProtectedHeader,
  ): Promise<string> {
    return new SignJWT(claims as JWTPayload)
      .setProtectedHeader(protectedHeader)
      .sign(this.#key);
  }
}

export interface CapabilityIssuerConfig {
  readonly issuer: string;
  readonly signer: CapabilitySigner;
  readonly defaultLifetimeSeconds?: number;
  readonly maximumLifetimeSeconds?: number;
  readonly notBeforeBackdateSeconds?: number;
  readonly now?: () => number;
  readonly generateJti?: () => string;
}

export interface IssueCapabilityInput {
  readonly subject: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly sessionId?: string;
  readonly permissions: readonly CapabilityPermission[];
  readonly lifetimeSeconds?: number;
  readonly jti?: string;
}

export class CapabilityIssuer {
  readonly #config: Required<
    Pick<
      CapabilityIssuerConfig,
      | "defaultLifetimeSeconds"
      | "maximumLifetimeSeconds"
      | "notBeforeBackdateSeconds"
      | "now"
      | "generateJti"
    >
  > & Pick<CapabilityIssuerConfig, "issuer" | "signer">;

  constructor(config: CapabilityIssuerConfig) {
    requireNonEmpty(config.issuer, "Capability issuer");
    if (config.signer.algorithm !== CapabilityAlgorithm) {
      throw new TypeError(`Capability signer must use ${CapabilityAlgorithm}`);
    }
    requireNonEmpty(config.signer.kid, "Signing key ID");

    const maximumLifetimeSeconds = config.maximumLifetimeSeconds
      ?? MaximumCapabilityLifetimeSeconds;
    const defaultLifetimeSeconds = config.defaultLifetimeSeconds
      ?? DefaultCapabilityLifetimeSeconds;
    const notBeforeBackdateSeconds = config.notBeforeBackdateSeconds ?? 5;
    requireIntegerRange(
      maximumLifetimeSeconds,
      1,
      MaximumCapabilityLifetimeSeconds,
      "Maximum capability lifetime",
    );
    requireIntegerRange(
      defaultLifetimeSeconds,
      1,
      maximumLifetimeSeconds,
      "Default capability lifetime",
    );
    requireIntegerRange(
      notBeforeBackdateSeconds,
      0,
      MaximumCapabilityClockSkewSeconds,
      "Capability not-before backdate",
    );

    this.#config = {
      issuer: config.issuer,
      signer: config.signer,
      defaultLifetimeSeconds,
      maximumLifetimeSeconds,
      notBeforeBackdateSeconds,
      now: config.now ?? (() => Date.now() / 1000),
      generateJti: config.generateJti ?? (() => crypto.randomUUID()),
    };
  }

  get keyId(): string {
    return this.#config.signer.kid;
  }

  async issue(input: IssueCapabilityInput): Promise<string> {
    requireNonEmpty(input.subject, "Capability subject");
    requireNonEmpty(input.audience, "Capability audience");
    requireNonEmpty(input.tenantId, "Capability tenant ID");
    if (input.sessionId !== undefined) {
      requireNonEmpty(input.sessionId, "Capability session ID");
    }

    const permissions = validatePermissionSet(
      input.permissions,
      input.tenantId,
      input.sessionId,
    );
    const lifetimeSeconds = input.lifetimeSeconds
      ?? this.#config.defaultLifetimeSeconds;
    requireIntegerRange(
      lifetimeSeconds,
      1,
      this.#config.maximumLifetimeSeconds,
      "Capability lifetime",
    );

    const issuedAt = Math.floor(this.#config.now());
    if (!Number.isSafeInteger(issuedAt)) {
      throw new TypeError("Capability clock must return epoch seconds");
    }
    const jti = input.jti ?? this.#config.generateJti();
    requireNonEmpty(jti, "Capability token ID");

    const claims = Object.freeze({
      ver: CapabilityVersion,
      iss: this.#config.issuer,
      sub: input.subject,
      aud: input.audience,
      iat: issuedAt,
      nbf: issuedAt - this.#config.notBeforeBackdateSeconds,
      exp: issuedAt + lifetimeSeconds,
      jti,
      tenantId: input.tenantId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      permissions,
    }) as CapabilityClaims;

    return this.#config.signer.sign(claims, {
      alg: CapabilityAlgorithm,
      kid: this.#config.signer.kid,
      typ: CapabilityTokenType,
    });
  }
}

function validatePermissionSet(
  permissions: readonly CapabilityPermission[],
  tenantId: string,
  sessionId: string | undefined,
): readonly CapabilityPermission[] {
  if (permissions.length === 0) {
    throw new TypeError("Capability permissions must not be empty");
  }
  const unique = new Set<string>();
  for (const permission of permissions) {
    const parsed = parseCapabilityPermission(permission);
    if (!parsed || parsed.tenantId !== tenantId) {
      throw new TypeError("Capability permission does not match its tenant");
    }
    if (parsed.sessionId !== undefined && parsed.sessionId !== sessionId) {
      throw new TypeError("Capability permission does not match its session");
    }
    if (parsed.kind.startsWith("sessions:") && sessionId === undefined) {
      throw new TypeError("Session permissions require a session-scoped capability");
    }
    if (parsed.kind === "cas:admin" && sessionId !== undefined) {
      throw new TypeError("Session-scoped capabilities cannot contain cas:admin");
    }
    if (unique.has(permission)) {
      throw new TypeError("Capability permissions must not contain duplicates");
    }
    unique.add(permission);
  }
  return Object.freeze([...permissions]);
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function requireIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}