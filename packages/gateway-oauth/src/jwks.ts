import { CapabilityAlgorithm } from "@unidocs/service-auth";

export interface GatewayOAuthPublicSigningKey {
  readonly kid: string;
  readonly algorithm: typeof CapabilityAlgorithm;
  readonly publicJwk: Readonly<Record<string, unknown>>;
}

export interface GatewayOAuthSigningKeySetPort {
  publicSigningKeys(): Promise<readonly GatewayOAuthPublicSigningKey[]>;
}

export interface GatewayOAuthJwks {
  readonly keys: readonly Readonly<Record<string, unknown>>[];
}

const FORBIDDEN_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "jku", "x5u"] as const;

export function renderGatewayOAuthJwks(
  keys: readonly GatewayOAuthPublicSigningKey[],
): GatewayOAuthJwks {
  if (keys.length === 0) throw new TypeError("OAuth signing key set must not be empty");
  const kids = new Set<string>();
  const rendered = keys.map(({ kid, algorithm, publicJwk }) => {
    if (kid.length === 0) throw new TypeError("OAuth signing key ID must not be empty");
    if (kids.has(kid)) throw new TypeError(`Duplicate OAuth signing key ID: ${kid}`);
    kids.add(kid);
    if (algorithm !== CapabilityAlgorithm) {
      throw new TypeError(`OAuth signing key must use ${CapabilityAlgorithm}`);
    }
    for (const member of FORBIDDEN_JWK_MEMBERS) {
      if (member in publicJwk) throw new TypeError(`OAuth public JWK must not contain ${member}`);
    }
    if (publicJwk.kty !== "EC" || publicJwk.crv !== "P-256"
      || typeof publicJwk.x !== "string" || publicJwk.x.length === 0
      || typeof publicJwk.y !== "string" || publicJwk.y.length === 0) {
      throw new TypeError("OAuth public JWK must be an EC P-256 public key");
    }
    if (publicJwk.kid !== undefined && publicJwk.kid !== kid) {
      throw new TypeError("OAuth public JWK kid must match its key descriptor");
    }
    if (publicJwk.alg !== undefined && publicJwk.alg !== CapabilityAlgorithm) {
      throw new TypeError(`OAuth public JWK alg must be ${CapabilityAlgorithm}`);
    }
    if (publicJwk.use !== undefined && publicJwk.use !== "sig") {
      throw new TypeError("OAuth public JWK use must be sig");
    }
    return Object.freeze({ ...publicJwk, kid, alg: CapabilityAlgorithm, use: "sig" });
  });
  return Object.freeze({ keys: Object.freeze(rendered) });
}
