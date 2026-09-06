import { exportJWK, importPKCS8, SignJWT } from "jose";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  CapabilityVersion,
  casManagePermission,
  casReadPermission,
  casWritePermission,
} from "@unicas/tenant-protocol";
import type {
  ControlOAuthIssuerRecord,
  ManagedCapabilityIssuer,
} from "@unicas/service";
import { managedPlaygroundOwnerKey } from "@unicas/service";

const CAPABILITY_LIFETIME_SECONDS = 60 * 60;

export interface ManagedIssuerOptions {
  readonly publicOrigin: string;
  readonly privateKeyPkcs8: string;
  readonly keyId: string;
  readonly now?: () => number;
}

export class CloudflareManagedIssuer implements ManagedCapabilityIssuer {
  readonly #origin: string;
  readonly #privateKeyPkcs8: string;
  readonly #keyId: string;
  readonly #now: () => number;
  #materialPromise: Promise<KeyMaterial> | null = null;

  constructor(options: ManagedIssuerOptions) {
    this.#origin = new URL(options.publicOrigin).origin;
    if (!options.privateKeyPkcs8) throw new TypeError("managed issuer private key is required");
    if (!options.keyId) throw new TypeError("managed issuer key ID is required");
    this.#privateKeyPkcs8 = options.privateKeyPkcs8;
    this.#keyId = options.keyId;
    this.#now = options.now ?? (() => Date.now());
  }

  async provision(stackId: string, createdAt: number): Promise<ControlOAuthIssuerRecord> {
    const material = await this.#material();
    const issuer = this.issuer(stackId);
    return {
      stackId,
      mode: "managed",
      issuer,
      audience: `${this.#origin}/stacks/${encodeURIComponent(stackId)}`,
      metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
      metadataType: "oauth",
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksUri: `${issuer}/jwks.json`,
      registrationEndpoint: null,
      scopesSupported: ["cas:read", "cas:write", "cas:manage"],
      codeChallengeMethodsSupported: ["S256"],
      status: "active",
      verifiedAt: createdAt,
      lastRefreshAt: createdAt,
      lastRefreshError: null,
      jwksDigest: material.digest,
      capabilityMaxLifetimeSeconds: CAPABILITY_LIFETIME_SECONDS,
      revision: 1,
    };
  }

  async issue(input: Parameters<ManagedCapabilityIssuer["issue"]>[0]) {
    const expectedIssuer = this.issuer(input.stack.stackId);
    if (input.issuer.issuer !== expectedIssuer || input.issuer.mode !== "managed") {
      throw new TypeError("managed issuer binding does not match the stack");
    }
    const material = await this.#material();
    const identityDigest = await managedPlaygroundOwnerKey(input.stack.stackId, input.identity);
    const tenantId = `member_${identityDigest.slice(0, 24)}`;
    const subject = `member:${identityDigest}`;
    const permissions = [
      casReadPermission(tenantId),
      casWritePermission(tenantId),
      casManagePermission(tenantId),
    ];
    const issuedAt = Math.floor(this.#now() / 1000);
    const expiresAt = issuedAt + CAPABILITY_LIFETIME_SECONDS;
    const accessToken = await new SignJWT({
      ver: CapabilityVersion,
      tenantId,
      permissions,
      refDomain: `playground:${identityDigest.slice(0, 16)}`,
    })
      .setProtectedHeader({ alg: CapabilityAlgorithm, kid: this.#keyId, typ: CapabilityTokenType })
      .setIssuer(expectedIssuer)
      .setSubject(subject)
      .setAudience(input.issuer.audience)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt - 5)
      .setExpirationTime(expiresAt)
      .setJti(crypto.randomUUID())
      .sign(material.privateKey);
    return {
      accessToken,
      tokenType: "Bearer" as const,
      expiresIn: CAPABILITY_LIFETIME_SECONDS,
      expiresAt: expiresAt * 1000,
      issuer: expectedIssuer,
      audience: input.issuer.audience,
      tenantId,
      permissions,
    };
  }

  async metadata(stackId: string): Promise<Readonly<Record<string, unknown>>> {
    const issuer = this.issuer(stackId);
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["cas:read", "cas:write", "cas:manage"],
    };
  }

  async jwks(): Promise<Readonly<Record<string, unknown>>> {
    return { keys: [(await this.#material()).publicJwk] };
  }

  issuer(stackId: string): string {
    return `${this.#origin}/managed-issuers/${encodeURIComponent(stackId)}`;
  }

  #material(): Promise<KeyMaterial> {
    this.#materialPromise ??= loadKeyMaterial(this.#privateKeyPkcs8, this.#keyId);
    return this.#materialPromise;
  }
}

interface KeyMaterial {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

async function loadKeyMaterial(privateKeyPkcs8: string, keyId: string): Promise<KeyMaterial> {
  const privateKey = await importPKCS8(privateKeyPkcs8, CapabilityAlgorithm, { extractable: true });
  const exported = await exportJWK(privateKey);
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y) {
    throw new TypeError("managed issuer key must be EC P-256");
  }
  const publicJwk = {
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
    alg: CapabilityAlgorithm,
    use: "sig",
    kid: keyId,
  } as const;
  return {
    privateKey,
    publicJwk,
    digest: await sha256Hex(JSON.stringify({ keys: [publicJwk] })),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}