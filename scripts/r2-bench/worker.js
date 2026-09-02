// Temporary R2 latency benchmark worker (deployed for measurement, then deleted).
// GET /bench?n=5&size=1024&op=all&bucket=cas|preview  — plain worker colo
// GET /dofetch?n=5&size=1024&op=all&bucket=cas|preview — inside a Durable Object
// Times R2 PUT (with sha256, like the CAS path), GET, HEAD, DELETE.
// No D1, no capability logic. The DO variant isolates DO->R2 vs worker->R2.
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/dofetch") {
        const stub = env.BENCH_DO.get(env.BENCH_DO.idFromName("bench"));
        return stub.fetch(request);
      }
      return Response.json(await bench(request, env, url.searchParams.get("bucket") === "preview" ? env.BUCKET_PREVIEW : env.BUCKET));
    } catch (err) {
      return Response.json({ error: String(err), stack: err?.stack ?? null }, { status: 500 });
    }
  },
};

export class BenchDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const bucket = url.searchParams.get("bucket") === "preview" ? this.env.BUCKET_PREVIEW : this.env.BUCKET;
    const out = await bench(request, this.env, bucket);
    out.doColo = request.cf?.colo ?? "unknown";
    out.doId = this.state.id.toString();
    return Response.json(out);
  }
}

async function bench(request, env, bucket) {
  const url = new URL(request.url);
  const colo = request.cf?.colo ?? "unknown";
  const n = clampInt(url.searchParams.get("n"), 5, 1, 50);
  const size = clampInt(url.searchParams.get("size"), 1024, 1, 4 * 1024 * 1024);
  const op = url.searchParams.get("op") ?? "all";
  const rounds = [];
  for (let i = 0; i < n; i++) {
    const key = `bench/${crypto.randomUUID()}`;
    const body = new Uint8Array(size).fill(0x2a);
    const record = { colo, size };
    if (op === "all" || op === "put") {
      const s = performance.now();
      await bucket.put(key, body, { sha256: await sha256Hex(body) });
      record.putMs = +(performance.now() - s).toFixed(1);
    } else {
      await bucket.put(key, body);
    }
    if (op === "all" || op === "get") {
      const s = performance.now();
      const obj = await bucket.get(key);
      record.getMs = obj ? +(performance.now() - s).toFixed(1) : -1;
    }
    if (op === "all" || op === "head") {
      const s = performance.now();
      const obj = await bucket.head(key);
      record.headMs = obj ? +(performance.now() - s).toFixed(1) : -1;
    }
    if (op === "all" || op === "delete") {
      const s = performance.now();
      await bucket.delete(key);
      record.deleteMs = +(performance.now() - s).toFixed(1);
    }
    rounds.push(record);
  }
  return { bucket: url.searchParams.get("bucket") ?? "cas", n, size, op, ts: Date.now(), rounds };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}
