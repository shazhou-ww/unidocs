import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeNodeDigest, encodeHeader, hashToHex } from "@unicas/codec";
import { CasClientError } from "@unicas/tenant-blob-client";
import { SValueContentType } from "@unidocs/protocol";
import type {
  DocumentMemoryProbe,
  DocumentMemoryProbeSample,
  SBlobSource,
  SValue,
} from "@unidocs/protocol";
import { encodeSValue } from "@unidocs/svalue-codec";
import { createSBlobContext } from "@unidocs/doctype-server-common";
import type { SBlobCasAdapter } from "@unidocs/doctype-server-common";
import { createDocxDocumentType } from "../src/index.js";

interface CapturedSample extends DocumentMemoryProbeSample {
  readonly elapsedMs: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly rss: number;
}

const verbose = process.env.DOCX_MEMORY_PROBE === "1";
const casConcurrency = Number(process.env.DOCX_MEMORY_PROBE_CAS_CONCURRENCY ?? "2");

describe("DOCX create memory probe", () => {
  it("samples empty init, part fanout, snapshot, and delta stages", async () => {
    const startedAt = performance.now();
    const samples: CapturedSample[] = [];
    const probe: DocumentMemoryProbe = sample => {
      const memory = process.memoryUsage();
      samples.push({
        ...sample,
        elapsedMs: performance.now() - startedAt,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        rss: memory.rss,
      });
    };

    const adapter = memoryCasAdapter();
    const context = createSBlobContext(adapter, { casConcurrency, memoryProbe: probe });
    const doc = await createDocxDocumentType(context).init();

    const snapshotBytes = encodeSValue(doc as unknown as SValue);
    probe({ stage: "commit.snapshot.encoded", details: { snapshotBytes: snapshotBytes.length } });
    const snapshot = await context.makeSBlob({ data: snapshotBytes, contentType: SValueContentType });
    probe({ stage: "commit.snapshot.uploaded", details: { snapshotBytes: snapshotBytes.length } });

    const deltaBytes = encodeSValue({ kind: "restore", doc: snapshot });
    probe({ stage: "commit.delta.encoded", details: { deltaBytes: deltaBytes.length } });
    await context.makeSBlob({ data: deltaBytes, contentType: SValueContentType });
    probe({ stage: "commit.delta.uploaded", details: { deltaBytes: deltaBytes.length } });

    const stages = samples.map(sample => sample.stage);
    expect(stages).toEqual(expect.arrayContaining([
      "docx.package.saved",
      "docx.package.extracted",
      "docx.parts.upload.complete",
      "commit.snapshot.encoded",
      "commit.snapshot.uploaded",
      "commit.delta.uploaded",
    ]));
    expect(Math.max(
      ...samples
        .filter(sample => sample.stage === "cas.request.start")
        .map(sample => Number(sample.details?.inFlight ?? 0)),
    )).toBe(Math.min(casConcurrency, Object.keys(doc.files).length));

    if (verbose) printSamples(samples);
  });
});

function memoryCasAdapter(): SBlobCasAdapter {
  const stored = new Set<string>();
  const delay = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
  return {
    async leaseNode(hash) {
      await delay();
      if (!stored.has(hash)) throw new CasClientError(404, "Not Found", "leaseNode");
      return { hash };
    },
    async leaseNodeContent(hash, content) {
      const transportCopy = Uint8Array.from(content);
      await delay();
      stored.add(hash);
      return { bytes: transportCopy.length };
    },
    async storeBlob(source) {
      const data = await sourceBytes(source);
      const transportCopy = Uint8Array.from(data);
      await delay();
      const header = encodeHeader(transportCopy.length, source.contentType, 0);
      const hash = hashToHex(await computeNodeDigest(header, source.contentType, [], transportCopy));
      stored.add(hash);
      return { hash };
    },
    async openBlob() {
      throw new Error("openBlob is not used by the create probe");
    },
  };
}

async function sourceBytes(source: SBlobSource): Promise<Uint8Array> {
  if ("data" in source) return source.data;
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source.body) {
    hash.update(chunk);
    chunks.push(chunk);
    length += chunk.length;
  }
  hash.digest();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function printSamples(samples: readonly CapturedSample[]): void {
  const baseline = samples[0];
  const selected = samples.filter((sample, index) =>
    !sample.stage.startsWith("cas.request")
    || (sample.stage === "cas.request.start"
      && Number(sample.details?.inFlight ?? 0) > Math.max(
        0,
        ...samples.slice(0, index)
          .filter(previous => previous.stage === "cas.request.start")
          .map(previous => Number(previous.details?.inFlight ?? 0)),
      )),
  );
  console.log(`\nDOCX empty-create memory probe (CAS concurrency ${casConcurrency}; Node process; deltas from first sample)`);
  console.log("stage                              ms   heap MB   ext MB array MB   rss MB  details");
  for (const sample of selected) {
    console.log([
      sample.stage.padEnd(34),
      sample.elapsedMs.toFixed(1).padStart(7),
      mb(sample.heapUsed - baseline.heapUsed).padStart(9),
      mb(sample.external - baseline.external).padStart(8),
      mb(sample.arrayBuffers - baseline.arrayBuffers).padStart(8),
      mb(sample.rss - baseline.rss).padStart(8),
      sample.details ? JSON.stringify(sample.details) : "",
    ].join(" "));
  }
  const peak = (key: "heapUsed" | "external" | "arrayBuffers" | "rss") =>
    Math.max(...samples.map(sample => sample[key] - baseline[key]));
  console.log(`peaks above baseline: heap=${mb(peak("heapUsed"))} MB external=${mb(peak("external"))} MB arrayBuffers=${mb(peak("arrayBuffers"))} MB rss=${mb(peak("rss"))} MB\n`);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}