import { createTenantCasClient, type HttpFetcher } from "@unicas/tenant-client";
import { storeNodeContent } from "@unicas/tenant-blob-client";
import { SValueContentType, type SValue } from "@unidocs/protocol";
import type { EditorContext, Invocation } from "@unidocs/protocol-doctype";
import { decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import { signPlatformRequest, type PlatformHmacKey } from "@unidocs/service-auth";
import type { PlatformEditorSnapshotPort } from "./platform-editor-commit.js";

const MAX_SNAPSHOT_RESPONSE_BYTES = 1_100_000;

export interface PlatformComputeSnapshotOptions {
  readonly computeOrigin: string;
  readonly snapshotPath: string;
  readonly computeFetcher: HttpFetcher;
  readonly hmacKey: PlatformHmacKey;
  readonly casStackId: string;
  readonly casFetcher: HttpFetcher;
  readonly getComputeAuthorization: () => Promise<string>;
  readonly getPlatformAuthorization: () => Promise<string>;
  readonly now?: () => number;
}

export function createPlatformComputeSnapshot(
  options: PlatformComputeSnapshotOptions,
  invocation: Invocation,
  context: EditorContext,
): PlatformEditorSnapshotPort {
  const origin = new URL(options.computeOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.computeOrigin) {
    throw new TypeError("Compute requires an exact HTTPS origin");
  }
  if (!options.snapshotPath.startsWith("/") || options.snapshotPath.includes("?")) {
    throw new TypeError("Invalid compute snapshot path");
  }
  const target = { origin: options.computeOrigin, paths: [options.snapshotPath] };
  return {
    async capture(): Promise<SValue> {
      const signed = await signPlatformRequest({
        url: options.computeOrigin + options.snapshotPath,
        target,
        key: options.hmacKey,
        body: encodeSValue({ invocation: { ...invocation }, context: { ...context } }),
        casAuthorization: await options.getComputeAuthorization(),
        now: options.now,
      });
      const response = await options.computeFetcher.fetch(new Request(signed, { redirect: "manual" }));
      if (response.status >= 300 && response.status < 400) throw new Error("Compute snapshot redirect rejected");
      if (!response.ok || response.headers.get("content-type") !== SValueContentType) {
        throw new Error(`Compute snapshot failed with status ${response.status}`);
      }
      const bytes = await boundedBytes(response, MAX_SNAPSHOT_RESPONSE_BYTES);
      const result = decodeSValue(bytes);
      if (!isSuccess(result)) throw new Error("Compute snapshot failed");
      return result.data;
    },
    async store(snapshot): Promise<string> {
      const cas = createTenantCasClient({
        baseUrl: "https://cas.internal",
        stackId: options.casStackId,
        tenantId: invocation.tenantId,
        fetcher: options.casFetcher,
        getToken: async () => bearerToken(await options.getPlatformAuthorization()),
      });
      return storeNodeContent(cas, encodeSValue(snapshot), SValueContentType);
    },
  };
}

function isSuccess(value: SValue): value is { readonly success: true; readonly data: SValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, SValue>>;
  return Object.keys(record).length === 2 && record.success === true && Object.hasOwn(record, "data");
}

function bearerToken(authorization: string): string {
  if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw new Error("Invalid platform CAS authorization");
  return authorization.slice(7);
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("Compute snapshot response exceeds limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximum) {
        await reader.cancel();
        throw new Error("Compute snapshot response exceeds limit");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}