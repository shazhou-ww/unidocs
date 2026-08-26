import { expect, test } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  CapabilityVerifier,
  JoseCapabilitySigner,
} from "@unidocs/service-auth";
import { GatewayCapabilityAuthority } from "../src/capability-authority.js";

const SampleCount = 50;
const WarmupCount = 5;
const MaximumP95Milliseconds = 100;

test("two signatures plus local Doc and CAS verification stay within the latency gate", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const issuerName = "unidocs-gateway:latency-test";
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const issuer = new CapabilityIssuer({
    issuer: issuerName,
    signer: new JoseCapabilitySigner(pair.privateKey, "latency-key"),
  });
  const authority = new GatewayCapabilityAuthority({
    issuer,
    casAudience: "unidocs-cas",
  });
  const jwks = {
    keys: [{ ...publicJwk, kid: "latency-key", alg: CapabilityAlgorithm }],
  };
  const docVerifier = new CapabilityVerifier({
    issuer: issuerName,
    audience: "unidocs-doc:docx",
    algorithm: CapabilityAlgorithm,
    jwks,
    allowedPermissionKinds: ["sessions:create", "sessions:read", "sessions:write"],
    allowedSubjects: ["gateway"],
  });
  const casVerifier = new CapabilityVerifier({
    issuer: issuerName,
    audience: "unidocs-cas",
    algorithm: CapabilityAlgorithm,
    jwks,
    allowedPermissionKinds: ["cas:read", "cas:write", "cas:admin"],
    allowedSubjects: ["doc:docx"],
  });

  const exercise = async (): Promise<void> => {
    const credentials = await authority.issueDocOperation({
      operation: "apply",
      docType: "docx",
      docAudience: "unidocs-doc:docx",
      tenantId: "tenant-latency",
      sessionId: "session-latency",
    });
    const docToken = credentials.authorization.slice("Bearer ".length);
    const delegatedToken = credentials.delegatedCasCapability!;
    await Promise.all([
      docVerifier.verify(docToken),
      casVerifier.verify(delegatedToken),
    ]);
    await casVerifier.verify(delegatedToken);
  };

  for (let index = 0; index < WarmupCount; index += 1) await exercise();

  const samples: number[] = [];
  const suiteStart = performance.now();
  for (let index = 0; index < SampleCount; index += 1) {
    const start = performance.now();
    await exercise();
    samples.push(performance.now() - start);
  }
  const totalMilliseconds = performance.now() - suiteStart;
  samples.sort((left, right) => left - right);
  const p50Milliseconds = percentile(samples, 0.5);
  const p95Milliseconds = percentile(samples, 0.95);
  const operationsPerSecond = SampleCount / (totalMilliseconds / 1_000);

  console.info(JSON.stringify({
    event: "capability_latency",
    samples: SampleCount,
    p50Milliseconds: round(p50Milliseconds),
    p95Milliseconds: round(p95Milliseconds),
    operationsPerSecond: round(operationsPerSecond),
  }));

  expect(p95Milliseconds).toBeLessThan(MaximumP95Milliseconds);
});

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}