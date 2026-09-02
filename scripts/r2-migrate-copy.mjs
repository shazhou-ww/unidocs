// Migrate unidocs-cas -> unidocs-cas-apac via the Cloudflare v4 object API.
// Usage: node scripts/r2-migrate-copy.mjs [--dry-run] [--limit N]
const ACCOUNT = "92c3c4fdcc84a1590555bccf4f111de2";
const TOKEN = "cfut_cxisKZNX0cO1jTo6k2KDvvoiC3SMuazKxDyHUA9V96291083";
const SRC = "unidocs-cas";
const DST = "unidocs-cas-apac";
const SKIP_PREFIX = "bench/";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

async function listAll(bucket) {
  const keys = [];
  let cursor;
  do {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}/objects`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`list ${bucket}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (!body.success) throw new Error(`list ${bucket}: ${JSON.stringify(body.errors)}`);
    for (const obj of body.result) keys.push(obj);
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
  } while (cursor);
  return keys;
}

async function copyOne(key) {
  const getRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${SRC}/objects/${key}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  if (!getRes.ok) throw new Error(`GET ${key}: ${getRes.status}`);
  const bytes = await getRes.arrayBuffer();
  const putRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${DST}/objects/${key}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: bytes,
    },
  );
  const putBody = await putRes.json().catch(() => null);
  if (!putRes.ok || !putBody?.success) {
    throw new Error(`PUT ${key}: ${putRes.status} ${JSON.stringify(putBody)}`);
  }
  return { key, size: bytes.byteLength };
}

const src = await listAll(SRC);
const dest = await listAll(DST);
const srcReal = src.filter((o) => !o.key.startsWith(SKIP_PREFIX));
const destReal = dest.filter((o) => !o.key.startsWith(SKIP_PREFIX));
const srcBytes = srcReal.reduce((s, o) => s + o.size, 0);
const destBytes = destReal.reduce((s, o) => s + o.size, 0);
console.log(`source: ${src.length} objects (${src.filter(o => o.key.startsWith(SKIP_PREFIX)).length} bench/, ${srcReal.length} real), ${srcBytes} bytes`);
console.log(`dest:   ${dest.length} objects (${destReal.length} real), ${destBytes} bytes`);
if (dryRun) {
  console.log("dry run — copying nothing");
  process.exit(0);
}

const toCopy = srcReal.filter((o) => !destReal.some((d) => d.key === o.key));
console.log(`to copy: ${toCopy.length} (${srcReal.length - toCopy.length} already present)`);
const plan = limit === Infinity ? toCopy : toCopy.slice(0, limit);
let ok = 0, failed = 0;
const started = Date.now();
const CONCURRENCY = 4;
let next = 0;
async function worker() {
  while (next < plan.length) {
    const item = plan[next++];
    try {
      await copyOne(item.key);
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok}/${plan.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${item.key}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${ok} copied, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);

// Verify
const destAfter = await listAll(DST);
const destAfterReal = destAfter.filter((o) => !o.key.startsWith(SKIP_PREFIX));
const missing = srcReal.filter((o) => !destAfterReal.some((d) => d.key === o.key));
const sizeMismatch = srcReal.filter((o) => {
  const d = destAfterReal.find((x) => x.key === o.key);
  return d && d.size !== o.size;
});
console.log(`verify: dest real=${destAfterReal.length} source real=${srcReal.length} missing=${missing.length} sizeMismatch=${sizeMismatch.length}`);
if (missing.length > 0) console.log("  missing:", missing.map((o) => o.key).slice(0, 10));
if (sizeMismatch.length > 0) console.log("  size mismatch:", sizeMismatch.map((o) => `${o.key} ${o.size}->${destAfterReal.find((d) => d.key === o.key)?.size}`).slice(0, 10));
process.exit(failed > 0 ? 1 : 0);
