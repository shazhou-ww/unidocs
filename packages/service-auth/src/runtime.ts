import { importPKCS8 } from "jose";
import {
  CapabilityAlgorithm,
  DefaultCapabilityLifetimeSeconds,
  MaximumCapabilityLifetimeSeconds,
} from "./claims.js";
import {
  CapabilityIssuer,
  JoseCapabilitySigner,
} from "./issuer.js";

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