import { describe, expect, test } from "vitest";
import { encodeHeader, hashToHex } from "@unicas/codec";
import {
  leaseReadyNode,
  MAX_LEASE_MS,
  nextNodeLease,
  parseLeaseDuration,
  type AdoptedCanonicalNodePlan,
  type CanonicalOrphanObject,
  type NodeLeaseRecord,
  type NodeLeaseRepository,
  type NodeLeaseScope,
} from "../src/index.js";

const SCOPE = { stackId: "cas_stack_a", tenantId: "tenant-1" };
const DURATION = 60_000;

class MemoryNodeLeaseRepository implements NodeLeaseRepository {
  lease: NodeLeaseRecord | null = null;
  object: CanonicalOrphanObject | null = null;
  canonical = new Uint8Array();
  ready = new Set<string>();
  renewed: { hash: string; lease: NodeLeaseRecord } | undefined;
  adopted: AdoptedCanonicalNodePlan | undefined;

  async readNodeLease(_scope: NodeLeaseScope, _hash: string) {
    return this.lease;
  }

  async readCanonicalObject(_scope: NodeLeaseScope, _hash: string) {
    return this.object;
  }

  async readCanonicalPrefix(_scope: NodeLeaseScope, _hash: string, length: number) {
    const bytes = this.canonical.slice(0, length);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async isNodeReady(_scope: NodeLeaseScope, hash: string) {
    return this.ready.has(hash);
  }

  async renewNodeLease(_scope: NodeLeaseScope, hash: string, lease: NodeLeaseRecord) {
    this.renewed = { hash, lease };
  }

  async commitAdoptedCanonicalNode(
    _scope: NodeLeaseScope,
    plan: AdoptedCanonicalNodePlan,
  ) {
    this.adopted = plan;
  }
}

describe("bodyless node lease service kernel", () => {
  test("parses and clamps lease duration policy", () => {
    expect(parseLeaseDuration(null)).toBe(15 * 60_000);
    expect(parseLeaseDuration("1")).toBe(60_000);
    expect(parseLeaseDuration(String(2 * MAX_LEASE_MS))).toBe(MAX_LEASE_MS);
    expect(() => parseLeaseDuration("invalid")).toThrow("Invalid lease duration");
  });

  test("preserves an active lease start and never shortens its expiry", () => {
    expect(nextNodeLease({ leaseStartedAt: 10, leaseExpiresAt: 1000 }, 100, 100))
      .toEqual({ leaseStartedAt: 10, leaseExpiresAt: 1000 });
    expect(nextNodeLease({ leaseStartedAt: 10, leaseExpiresAt: 100 }, 50, 100))
      .toEqual({ leaseStartedAt: 100, leaseExpiresAt: 150 });
  });

  test("renews an existing ready node", async () => {
    const repository = new MemoryNodeLeaseRepository();
    repository.lease = { leaseStartedAt: 50, leaseExpiresAt: 200 };
    repository.ready.add("a".repeat(64));

    await expect(leaseReadyNode({
      repository,
      scope: SCOPE,
      hash: "a".repeat(64),
      leaseDurationMs: DURATION,
      now: () => 100,
    })).resolves.toEqual({
      hash: "a".repeat(64),
      ready: true,
      leaseStartedAt: 50,
      leaseExpiresAt: 60_100,
    });
    expect(repository.renewed).toEqual({
      hash: "a".repeat(64),
      lease: { leaseStartedAt: 50, leaseExpiresAt: 60_100 },
    });
  });

  test("rejects an existing node whose canonical object is missing", async () => {
    const repository = new MemoryNodeLeaseRepository();
    repository.lease = { leaseStartedAt: 50, leaseExpiresAt: 200 };

    await expect(leaseReadyNode({
      repository,
      scope: SCOPE,
      hash: "a".repeat(64),
      leaseDurationMs: DURATION,
    })).rejects.toMatchObject({ status: 409, code: "NODE_NOT_READY" });
  });

  test("treats absent, unverifiable, and oversized canonical orphans as missing", async () => {
    for (const object of [
      null,
      { storedBytes: 10 },
      { storedBytes: 10, sha256Hex: "b".repeat(64) },
      { storedBytes: 101, sha256Hex: "a".repeat(64) },
    ] satisfies Array<CanonicalOrphanObject | null>) {
      const repository = new MemoryNodeLeaseRepository();
      repository.object = object;
      await expect(leaseReadyNode({
        repository,
        scope: SCOPE,
        hash: "a".repeat(64),
        leaseDurationMs: DURATION,
        limits: { maxCanonicalNodeBytes: 100 },
      })).rejects.toMatchObject({ status: 404, code: "NODE_NOT_FOUND" });
    }
  });

  test("adopts a verified canonical orphan after checking its children", async () => {
    const child = "b".repeat(64);
    const content = new TextEncoder().encode("payload");
    const contentType = "text/plain";
    const canonical = concatenate(
      encodeHeader(content.length, contentType, 1),
      new TextEncoder().encode(contentType),
      hexBytes(child),
      content,
    );
    const hash = hashToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)));
    const repository = new MemoryNodeLeaseRepository();
    repository.object = { storedBytes: canonical.length, sha256Hex: hash };
    repository.canonical = canonical;
    repository.ready.add(child);

    await expect(leaseReadyNode({
      repository,
      scope: SCOPE,
      hash,
      leaseDurationMs: DURATION,
      now: () => 100,
    })).resolves.toEqual({ hash, ready: true, leaseStartedAt: 100, leaseExpiresAt: 60_100 });
    expect(repository.adopted).toEqual({
      hash,
      contentSize: content.length,
      contentType,
      refs: [child],
      storedBytes: canonical.length,
      leaseStartedAt: 100,
      leaseExpiresAt: 60_100,
      reservationCreatedAt: 100,
      reservationExpiresAt: 100 + MAX_LEASE_MS,
    });
  });

  test("rejects invalid orphan metadata and unready children", async () => {
    const repository = new MemoryNodeLeaseRepository();
    const hash = "a".repeat(64);
    repository.object = { storedBytes: 3, sha256Hex: hash };
    repository.canonical = new Uint8Array([1, 2, 3]);
    await expect(leaseReadyNode({
      repository,
      scope: SCOPE,
      hash,
      leaseDurationMs: DURATION,
    })).rejects.toMatchObject({ status: 409, code: "NODE_CONFLICT" });

    const child = "b".repeat(64);
    const content = new TextEncoder().encode("payload");
    const contentType = "text/plain";
    const canonical = concatenate(
      encodeHeader(content.length, contentType, 1),
      new TextEncoder().encode(contentType),
      hexBytes(child),
      content,
    );
    const canonicalHash = hashToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)));
    repository.object = { storedBytes: canonical.length, sha256Hex: canonicalHash };
    repository.canonical = canonical;
    await expect(leaseReadyNode({
      repository,
      scope: SCOPE,
      hash: canonicalHash,
      leaseDurationMs: DURATION,
    })).rejects.toMatchObject({ status: 409, code: "NODE_NOT_READY" });
  });

  test("rejects invalid hashes", async () => {
    await expect(leaseReadyNode({
      repository: new MemoryNodeLeaseRepository(),
      scope: SCOPE,
      hash: "invalid",
      leaseDurationMs: DURATION,
    })).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });
});

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function hexBytes(hash: string): Uint8Array {
  return Uint8Array.from(hash.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}
