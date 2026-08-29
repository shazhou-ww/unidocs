/**
 * Node write helpers: raw content → canonical node → lease.
 *
 * These encode the canonical node wire format (via @unicas/codec) and store
 * it through the tenant-client's `leaseNode`. They live in the blob layer
 * (not tenant-client) because tenant-client is a pure 1:1 mapping of the
 * HTTP API and does no encoding.
 */

import {
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unicas/codec";
import type {
  CasLeaseOptions,
  CasLeaseResult,
  TenantCasClient,
} from "@unicas/tenant-client";

async function encodeCanonicalNode(
  content: Uint8Array,
  contentType: string,
  refs: readonly string[],
): Promise<{ readonly hash: string; readonly bytes: Uint8Array }> {
  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(content.length, contentType, childHashes.length);
  return {
    hash: hashToHex(await computeNodeDigest(header, contentType, childHashes, content)),
    bytes: concatenateNodeBytes(
      header,
      new TextEncoder().encode(contentType),
      childHashes,
      content,
    ),
  };
}

export async function leaseNodeContent(
  cas: Pick<TenantCasClient, "leaseNode">,
  hash: string,
  content: Uint8Array,
  contentType: string,
  refs: readonly string[] = [],
  options?: CasLeaseOptions,
): Promise<CasLeaseResult> {
  const canonical = await encodeCanonicalNode(content, contentType, refs);
  if (canonical.hash !== hash) {
    throw new Error(`CAS node digest mismatch: expected ${hash}, got ${canonical.hash}`);
  }
  return cas.leaseNode(hash, {
    contentLength: canonical.bytes.length,
    body: streamBytes(canonical.bytes),
  }, options);
}

export async function storeNodeContent(
  cas: Pick<TenantCasClient, "leaseNode">,
  content: Uint8Array,
  contentType: string,
  refs: readonly string[] = [],
  options?: CasLeaseOptions,
): Promise<string> {
  const canonical = await encodeCanonicalNode(content, contentType, refs);
  await cas.leaseNode(canonical.hash, {
    contentLength: canonical.bytes.length,
    body: streamBytes(canonical.bytes),
  }, options);
  return canonical.hash;
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}
