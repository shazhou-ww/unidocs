import { DurableObject } from "cloudflare:workers";

const CANONICAL_NODE_CONTENT_TYPE = "application/vnd.unidocs.cas-node.v1";
const HEADER_BYTES = 24;
const MAX_REQUEST_BYTES = 4 * 1024;

export default {
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }
    if (!await secretsEqual(request.headers.get("X-Repro-Key") ?? "", env.REPRO_KEY)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) {
      return new Response("Request too large", { status: 413 });
    }

    try {
      const input = await request.json();
      const capability = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
      if (!capability) return new Response("Missing capability", { status: 401 });
      const instance = requiredString(input.instance, "instance");
      const result = await env.REPRO_DO.getByName(instance).run({
        capability,
        tenantId: requiredString(input.tenantId, "tenantId"),
        count: boundedInteger(input.count, "count", 1, 20),
        concurrency: boundedInteger(input.concurrency, "concurrency", 1, 20),
        contentBytes: boundedInteger(input.contentBytes, "contentBytes", 1, 4096),
        padMiB: boundedInteger(input.padMiB, "padMiB", 0, 112),
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};

export class CasUploadReproDO extends DurableObject {
  async run(input) {
    if (input.concurrency > input.count) throw new RangeError("concurrency must not exceed count");
    const startedAt = performance.now();
    const stages = [];
    const mark = (stage, details = {}) => stages.push({
      stage,
      elapsedMs: +(performance.now() - startedAt).toFixed(1),
      ...details,
    });

    const padding = new Uint8Array(input.padMiB * 1024 * 1024);
    for (let offset = 0; offset < padding.length; offset += 4096) padding[offset] = offset & 0xff;
    mark("padding.ready", { padMiB: input.padMiB });

    const nodes = await Promise.all(Array.from({ length: input.count }, (_, index) =>
      canonicalNode(input.contentBytes, `${crypto.randomUUID()}:${index}`)));
    mark("nodes.ready", {
      count: nodes.length,
      contentBytes: input.contentBytes,
      canonicalBytes: nodes.reduce((total, node) => total + node.bytes.length, 0),
    });

    let cursor = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const results = new Array(nodes.length);
    const uploadOne = async (index) => {
      const node = nodes[index];
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const requestStartedAt = performance.now();
      try {
        const response = await this.env.CAS_SERVICE.fetch(
          `https://cas.internal/stacks/${encodeURIComponent(this.env.CAS_STACK_ID)}`
            + `/tenants/${encodeURIComponent(input.tenantId)}/cas/nodes/${node.hash}/lease`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${input.capability}`,
              "Content-Type": CANONICAL_NODE_CONTENT_TYPE,
              "Content-Length": String(node.bytes.length),
            },
            body: node.bytes,
          },
        );
        const responseText = await response.text();
        results[index] = {
          status: response.status,
          elapsedMs: +(performance.now() - requestStartedAt).toFixed(1),
          responseBytes: new TextEncoder().encode(responseText).length,
        };
      } finally {
        inFlight--;
      }
    };
    const uploadWorker = async () => {
      while (cursor < nodes.length) {
        const index = cursor++;
        await uploadOne(index);
      }
    };

    mark("uploads.start", { concurrency: input.concurrency });
    await Promise.all(Array.from({ length: input.concurrency }, uploadWorker));
    mark("uploads.complete", { peakInFlight });

    await this.ctx.storage.put("last-run", {
      completedAt: Date.now(),
      count: input.count,
      concurrency: input.concurrency,
      paddingSentinel: padding.length === 0 ? 0 : padding[padding.length - 1],
    });
    mark("storage.complete");

    return {
      success: results.every(result => result.status >= 200 && result.status < 300),
      peakInFlight,
      stages,
      results,
    };
  }
}

async function canonicalNode(contentLength, seed) {
  const contentType = "application/octet-stream";
  const contentTypeBytes = new TextEncoder().encode(contentType);
  const content = new Uint8Array(contentLength);
  const seedBytes = new TextEncoder().encode(seed);
  for (let index = 0; index < content.length; index++) content[index] = seedBytes[index % seedBytes.length];
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = 0x55;
  header[1] = 0x44;
  view.setUint16(2, 1, true);
  view.setBigUint64(8, BigInt(content.length), true);
  view.setUint16(20, contentTypeBytes.length, true);
  const bytes = new Uint8Array(header.length + contentTypeBytes.length + content.length);
  bytes.set(header, 0);
  bytes.set(contentTypeBytes, header.length);
  bytes.set(content, header.length + contentTypeBytes.length);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return { hash, bytes };
}

async function secretsEqual(provided, expected) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new TypeError(`${name} must be a non-empty string of at most 200 characters`);
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}