import { importPKCS8 } from "jose";
import {
  CapabilityAlgorithm,
  DefaultCapabilityLifetimeSeconds,
  MaximumCapabilityClockSkewSeconds,
  MaximumCapabilityLifetimeSeconds,
} from "@unicas/tenant-protocol";
import {
  CapabilityIssuer,
  JoseCapabilitySigner,
} from "./issuer.js";

export interface CapabilityRuntimePolicyBindings {
  readonly CAPABILITY_ALGORITHM?: string;
  readonly CAPABILITY_TTL_SECONDS?: string;
  readonly CAPABILITY_MAX_LIFETIME_SECONDS?: string;
  readonly CAPABILITY_CLOCK_SKEW_SECONDS?: string;
}

export interface CapabilityRuntimePolicy {
  readonly algorithm: typeof CapabilityAlgorithm;
  readonly defaultLifetimeSeconds: number;
  readonly maximumLifetimeSeconds: number;
  readonly clockSkewSeconds: number;
}

export function parseCapabilityRuntimePolicy(
  bindings: CapabilityRuntimePolicyBindings,
): CapabilityRuntimePolicy {
  const algorithm = required(bindings.CAPABILITY_ALGORITHM, "CAPABILITY_ALGORITHM");
  if (algorithm !== CapabilityAlgorithm) {
    throw new TypeError(`CAPABILITY_ALGORITHM must be ${CapabilityAlgorithm}`);
  }
  const defaultLifetimeSeconds = integer(
    bindings.CAPABILITY_TTL_SECONDS,
    "CAPABILITY_TTL_SECONDS",
    1,
    MaximumCapabilityLifetimeSeconds,
  );
  const maximumLifetimeSeconds = integer(
    bindings.CAPABILITY_MAX_LIFETIME_SECONDS,
    "CAPABILITY_MAX_LIFETIME_SECONDS",
    1,
    MaximumCapabilityLifetimeSeconds,
  );
  if (defaultLifetimeSeconds > maximumLifetimeSeconds) {
    throw new TypeError("CAPABILITY_TTL_SECONDS must not exceed CAPABILITY_MAX_LIFETIME_SECONDS");
  }
  const clockSkewSeconds = integer(
    bindings.CAPABILITY_CLOCK_SKEW_SECONDS,
    "CAPABILITY_CLOCK_SKEW_SECONDS",
    0,
    MaximumCapabilityClockSkewSeconds,
  );
  return Object.freeze({
    algorithm: CapabilityAlgorithm,
    defaultLifetimeSeconds,
    maximumLifetimeSeconds,
    clockSkewSeconds,
  });
}

export interface Pkcs8CapabilityIssuerConfig {
  readonly issuer: string;
  readonly kid: string;
  readonly privateKeyPkcs8: string;
  readonly defaultLifetimeSeconds?: number;
  readonly maximumLifetimeSeconds?: number;
  readonly now?: () => number;
  readonly generateJti?: () => string;
}

export async function createPkcs8CapabilityIssuer(
  config: Pkcs8CapabilityIssuerConfig,
): Promise<CapabilityIssuer> {
  if (config.privateKeyPkcs8.length === 0) {
    throw new TypeError("Capability private key is required");
  }
  const key = await importPKCS8(config.privateKeyPkcs8, CapabilityAlgorithm);
  return new CapabilityIssuer({
    issuer: config.issuer,
    signer: new JoseCapabilitySigner(key, config.kid),
    defaultLifetimeSeconds: config.defaultLifetimeSeconds
      ?? DefaultCapabilityLifetimeSeconds,
    maximumLifetimeSeconds: config.maximumLifetimeSeconds
      ?? MaximumCapabilityLifetimeSeconds,
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.generateJti === undefined ? {} : { generateJti: config.generateJti }),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`Missing capability configuration: ${name}`);
  return value;
}

function integer(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(required(value, name));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}