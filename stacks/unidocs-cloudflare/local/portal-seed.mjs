/**
 * The local dev seed: registers the markdown document type on the portal a
 * `startLocalRuntime({ services: ["portal"] })` started, so tenants have
 * something to create documents of.
 *
 * Everything goes through the admin HTTP API, cookie + CSRF, exactly as the
 * Admin WebUI would send it — the draft, contract revision 0, the Type Card and
 * View bundles, pointing the markdown Operator at the new type, the Operator
 * validation, the Operator, and the enable. The one write that cannot go
 * through the API is signing in: local Google sign-in cannot be completed by a
 * program, so the seed writes a session for its own administrator straight
 * into D1 (R14). It never writes `portal_bootstrap`: claiming it would lock the
 * configured bootstrap email out of local sign-in for good. That email is
 * invited through the API instead.
 *
 * Idempotent and resumable: it finds the type by `internalName === "markdown"`
 * and only performs the steps that are still missing, so an interrupted run is
 * continued rather than repeated beside a second draft.
 *
 * No third-party dependencies (the bundles are STORED zips written below).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

const PORTAL_WORKER = "unidocs-portal";
const MARKDOWN_INTERNAL_NAME = "markdown";
/** The only base URL the portal's Markdown Operator validation target accepts (R12). */
const MARKDOWN_OPERATOR_BASE_URL = "https://unidocs-markdown.shazhou.workers.dev";
const SEED_ADMINISTRATOR = Object.freeze({
  email: "seed@unidocs.local",
  issuer: "https://accounts.google.com",
  subject: "local-portal-seed",
});
/** `SESSION_TTL_SECONDS` in packages/cloudflare-portal/src/auth.ts; the table's CHECK caps it. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_COOKIE = "__Host-unidocs_admin";
const SEED_REASON = "Registered by the local dev seed";

const SNAPSHOT_SCHEMA = Object.freeze({
  $schema: "https://schemas.unidocs.dev/svalue/v1",
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: { content: { type: "string" } },
});

const LOCATION_SCHEMA = Object.freeze({
  $schema: "https://schemas.unidocs.dev/svalue/v1",
  type: "object",
  required: ["locationType", "payload"],
  additionalProperties: false,
  properties: {
    locationType: { const: "unidocs.markdown.text-range/v1" },
    payload: {
      type: "object",
      required: ["start", "end", "quote"],
      additionalProperties: false,
      properties: {
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
        quote: { type: "string" },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// STORED zip writer
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * An uncompressed zip of `[path, string | Uint8Array]` entries, byte-for-byte
 * deterministic (fixed 1980-01-01 timestamps), so the same bundle always gets
 * the same content-derived id. UTF-8 names (flag bit 11), no extra fields, no
 * data descriptors, no attributes: the shape the portal's strict reader wants.
 */
export function storedZip(entries) {
  const encoder = new TextEncoder();
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const UTF8_NAMES = 0x0800;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = encoder.encode(path);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, UTF8_NAMES, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, UTF8_NAMES, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, DOS_TIME, true);
    centralView.setUint16(14, DOS_DATE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    // extra, comment, disk start, internal attributes: 0
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
  + '<rect x="0.5" y="2.5" width="15" height="11" rx="1.5" fill="none" stroke="#1f2328"/>'
  + '<path d="M3 11V5h1.5L6 7l1.5-2H9v6H7.5V7.5L6 9.5 4.5 7.5V11z" fill="#1f2328"/>'
  + '<path d="M11.5 5h1.5v3h1.5L12.25 11 10 8h1.5z" fill="#1f2328"/>'
  + "</svg>";

/** A 1×1 WebP, the same bytes portal-type-card-bundles.test.mjs uploads. */
function sampleWebp() {
  return Uint8Array.from(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
}

export function markdownTypeCardBundle(documentType) {
  const manifest = {
    protocol: "unidocs-type-card/v1",
    documentType,
    locales: {
      en: { name: "Markdown", description: "A plain Markdown text document.", sampleThumbnailAlt: "A Markdown document" },
    },
    icon: { kind: "svg", path: "icon.svg" },
    sampleThumbnail: "sample.webp",
  };
  return storedZip([
    ["unidocs-type-card.json", JSON.stringify(manifest)],
    ["icon.svg", ICON_SVG],
    ["sample.webp", sampleWebp()],
  ]);
}

export function markdownViewBundle(documentType) {
  const manifest = {
    protocol: "unidocs-view-bundle/v1",
    documentType,
    entrypoints: { interactive: "view.html", thumbnail: "thumbnail.html" },
    supportedDocumentContractIdxs: [0],
  };
  return storedZip([
    ["unidocs-view.json", JSON.stringify(manifest)],
    ["view.html", '<!doctype html><html lang="en"><meta charset="utf-8"><title>Markdown</title><main id="document"></main></html>'],
    ["thumbnail.html", '<!doctype html><html lang="en"><meta charset="utf-8"><title>Markdown preview</title><main>Markdown</main></html>'],
  ]);
}

// ---------------------------------------------------------------------------
// Seed administrator session (the one direct D1 write, R14)
// ---------------------------------------------------------------------------

function sha256Base64url(secret) {
  return createHash("sha256").update(secret).digest("base64url");
}

/**
 * Binds or reuses the seed administrator and gives it one fresh session, in
 * the shape `D1PortalAuthRepository.findSession` reads back and
 * `validateAdminIdentity` accepts. Earlier seed sessions are revoked the way
 * `completeLogin` revokes a member's previous ones.
 */
async function mintSeedSession(db) {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db.prepare("SELECT member_id FROM portal_administrators WHERE issuer = ? AND subject = ? AND active = 1")
    .bind(SEED_ADMINISTRATOR.issuer, SEED_ADMINISTRATOR.subject).first();
  const memberId = existing?.member_id ?? randomUUID();
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const familyId = randomUUID();
  const identity = { issuer: SEED_ADMINISTRATOR.issuer, subject: SEED_ADMINISTRATOR.subject, email: SEED_ADMINISTRATOR.email, authenticatedAt: now };
  const statements = [];
  if (!existing) {
    statements.push(db.prepare(`INSERT INTO portal_administrators (member_id, email, issuer, subject, added_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'local-seed', ?, ?)`).bind(memberId, SEED_ADMINISTRATOR.email, SEED_ADMINISTRATOR.issuer, SEED_ADMINISTRATOR.subject, now, now));
  }
  statements.push(
    db.prepare("UPDATE portal_session_families SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").bind(now, memberId),
    db.prepare("DELETE FROM portal_sessions WHERE family_id IN (SELECT family_id FROM portal_session_families WHERE member_id = ?)").bind(memberId),
    db.prepare("INSERT INTO portal_session_families (family_id, member_id, created_at) VALUES (?, ?, ?)").bind(familyId, memberId, now),
    db.prepare(`INSERT INTO portal_sessions (session_hash, family_id, csrf_hash, identity_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(sha256Base64url(token), familyId, sha256Base64url(csrf), JSON.stringify(identity), now, now + SESSION_TTL_SECONDS),
  );
  await db.batch(statements);
  return { token, csrf, created: !existing };
}

// ---------------------------------------------------------------------------
// Admin API client
// ---------------------------------------------------------------------------

function adminClient(origin, session) {
  return async function call(step, { method = "GET", path, query, json, zip, ifMatch, accept = [200] }) {
    const url = new URL(`/admin/api/v1${path}`, origin);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
    const headers = { cookie: `${ADMIN_COOKIE}=${session.token}` };
    if (method !== "GET") {
      headers.origin = origin;
      headers["x-csrf-token"] = session.csrf;
      headers["idempotency-key"] = randomUUID();
    }
    if (ifMatch) headers["if-match"] = ifMatch;
    let body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (zip) {
      headers["content-type"] = "application/zip";
      body = zip;
    }
    let response;
    let text;
    try {
      response = await fetch(url, { method, headers, body });
      text = await response.text();
    } catch (error) {
      throw new Error(`portal seed: ${step} failed: ${error.message}`, { cause: error });
    }
    if (!accept.includes(response.status)) {
      throw new Error(`portal seed: ${step} failed with HTTP ${response.status} ${method} ${url.pathname}: ${text}`);
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`portal seed: ${step} returned HTTP ${response.status} with a body that is not JSON: ${text}`);
    }
    return { status: response.status, body: parsed };
  };
}

/** Runs a step that is not an API call, naming it in any error it throws. */
async function step(name, run) {
  try {
    return await run();
  } catch (error) {
    if (typeof error?.message === "string" && error.message.startsWith("portal seed: ")) throw error;
    throw new Error(`portal seed: ${name} failed: ${error?.message ?? error}`, { cause: error });
  }
}

const encode = segment => encodeURIComponent(segment);

async function findMarkdownType(api) {
  let cursor;
  do {
    const { body } = await api("list document types", {
      path: "/document-types",
      query: { q: MARKDOWN_INTERNAL_NAME, limit: 100, ...(cursor ? { cursor } : {}) },
    });
    const match = body.items.find(item => item.internalName === MARKDOWN_INTERNAL_NAME);
    if (match) return match.documentType;
    cursor = body.nextCursor;
  } while (cursor);
  return null;
}

const getRegistration = (api, documentType) =>
  api("read document type", { path: `/document-types/${encode(documentType)}` }).then(({ body }) => body);

async function ensureContract(api, documentType, log) {
  const existing = await api("read document contract 0", {
    path: `/document-types/${encode(documentType)}/document-contracts/0`, accept: [200, 404],
  });
  if (existing.status === 200) return;
  const { body } = await api("append document contract 0", {
    method: "POST",
    path: `/document-types/${encode(documentType)}/document-contracts`,
    json: { formatVersion: 1, snapshot: { schema: SNAPSHOT_SCHEMA }, location: { schema: LOCATION_SCHEMA }, reason: SEED_REASON },
    accept: [201],
  });
  if (body.documentContractIdx !== 0) {
    throw new Error(`portal seed: append document contract 0 assigned index ${body.documentContractIdx} instead`);
  }
  log(`portal seed: appended document contract 0 to ${documentType}`);
}

/**
 * An already uploaded candidate for this type if there is one, else a fresh
 * upload. A same-content upload under another key answers 409 with the
 * existing id, which is just as good.
 */
async function ensureBundle(api, documentType, kind, log) {
  const collection = kind === "type-card" ? "/type-card-bundles" : "/view-bundles";
  const idField = kind === "type-card" ? "typeCardBundleId" : "viewBundleId";
  const label = kind === "type-card" ? "Type Card bundle" : "View bundle";
  const listed = await api(`list ${label}s`, { path: collection, query: { documentType, limit: 100 } });
  const reusable = listed.body.items.find(item => kind === "type-card" || item.supportedDocumentContractIdxs.includes(0));
  if (reusable) return reusable[idField];
  const uploaded = await api(`upload ${label}`, {
    method: "POST",
    path: collection,
    query: { name: `Markdown ${label} (local seed)`, description: SEED_REASON },
    zip: kind === "type-card" ? markdownTypeCardBundle(documentType) : markdownViewBundle(documentType),
    accept: [201, 409],
  });
  if (uploaded.status === 409) {
    const existingId = uploaded.body?.error?.code === "bundle_already_exists" ? uploaded.body.error.details?.[idField] : undefined;
    if (!existingId) throw new Error(`portal seed: upload ${label} failed with HTTP 409: ${JSON.stringify(uploaded.body)}`);
    return existingId;
  }
  log(`portal seed: uploaded ${label} ${uploaded.body[idField]}`);
  return uploaded.body[idField];
}

async function ensureOperator(api, documentType, log) {
  const listed = await api("list Operators", { path: "/operators", query: { documentType, limit: 100 } });
  const reusable = listed.body.items.find(item => item.supportedDocumentContractIdxs.includes(0));
  if (reusable) return reusable.operatorId;
  const validation = await api("validate the markdown Operator", {
    method: "POST",
    path: "/operator-validations",
    json: { baseUrl: MARKDOWN_OPERATOR_BASE_URL, expectedDocumentType: documentType, expectedConfigEtag: null },
    accept: [200, 201],
  });
  const created = await api("create the markdown Operator", {
    method: "POST",
    path: "/operators",
    json: { validationId: validation.body.validationId, name: "Markdown Operator (local seed)", description: SEED_REASON },
    accept: [201],
  });
  log(`portal seed: created Operator ${created.body.operatorId}`);
  return created.body.operatorId;
}

/**
 * Invites the configured bootstrap email, read off the running portal so it is
 * whatever was actually bound (`.dev.vars` or the environment). The seed
 * administrator already exists, so the bootstrap path is closed to it; an
 * invitation is what lets that account sign in.
 */
async function inviteBootstrapEmail(runtime, api, log) {
  const bindings = await step("read the portal bootstrap email", () => runtime.mf.getBindings(PORTAL_WORKER));
  const email = typeof bindings.PORTAL_BOOTSTRAP_EMAIL === "string" ? bindings.PORTAL_BOOTSTRAP_EMAIL.trim() : "";
  if (!email) return;
  const invited = await api("invite the bootstrap email", {
    method: "POST", path: "/administrators", json: { email }, accept: [201, 409],
  });
  if (invited.status === 409 && invited.body?.error?.code !== "administrator_exists") {
    throw new Error(`portal seed: invite the bootstrap email failed with HTTP 409: ${JSON.stringify(invited.body)}`);
  }
  if (invited.status === 201) log(`portal seed: invited ${email} as an administrator`);
}

/**
 * Registers (or finishes registering) the markdown document type, points the
 * runtime's markdown Operator at it, and invites the bound bootstrap email.
 * Idempotent: a complete registration costs one list, one read, one Operator
 * reconfiguration and the invitation check.
 *
 * @param {object} runtime The value `startLocalRuntime({ services: ["portal"] })` returned.
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<{ documentType: string }>}
 */
export async function seedPortalCatalog(runtime, { log = () => {} } = {}) {
  if (typeof runtime?.mf?.getD1Database !== "function" || typeof runtime.setMarkdownOperatorDocumentType !== "function") {
    throw new TypeError("seedPortalCatalog needs a Miniflare runtime started with services: [\"portal\"]");
  }
  // Both handles are used before the Operator is reconfigured and never after:
  // reconfiguring restarts workerd and poisons them.
  const origin = await step("read the portal origin", async () => {
    const value = (await runtime.mf.getBindings(PORTAL_WORKER)).PORTAL_ORIGIN;
    if (typeof value !== "string" || !value) throw new Error("PORTAL_ORIGIN is not bound");
    return value;
  });
  const session = await step("mint the seed administrator session", async () =>
    mintSeedSession(await runtime.mf.getD1Database("DB", PORTAL_WORKER)));
  if (session.created) log(`portal seed: bound seed administrator ${SEED_ADMINISTRATOR.email}`);
  const api = adminClient(origin, session);
  const pointOperatorAt = documentType => step("point the markdown Operator at the document type",
    () => runtime.setMarkdownOperatorDocumentType(documentType));

  let documentType = await findMarkdownType(api);
  let registration = documentType ? await getRegistration(api, documentType) : null;
  if (registration?.enabled && registration.builtinOperator) {
    await pointOperatorAt(documentType);
    await inviteBootstrapEmail(runtime, api, log);
    log(`portal seed: markdown is already registered as ${documentType}`);
    return { documentType };
  }

  if (!documentType) {
    const created = await api("create the markdown document type", {
      method: "POST", path: "/document-types", json: { internalName: MARKDOWN_INTERNAL_NAME }, accept: [201],
    });
    documentType = created.body.documentType;
    log(`portal seed: created document type ${documentType}`);
  } else {
    log(`portal seed: resuming the markdown draft ${documentType}`);
  }

  await ensureContract(api, documentType, log);
  registration = await getRegistration(api, documentType);
  const typeCardBundleId = registration.typeCardBundle?.typeCardBundleId ?? await ensureBundle(api, documentType, "type-card", log);
  const viewBundleId = registration.viewBundle?.viewBundleId ?? await ensureBundle(api, documentType, "view", log);
  // Before validation: the Operator's descriptor answers 503 until it knows the type.
  await pointOperatorAt(documentType);
  const operatorId = registration.builtinOperator?.operatorId ?? await ensureOperator(api, documentType, log);

  // Re-read: the ETag moves with every change above.
  registration = await getRegistration(api, documentType);
  const update = {
    ...(registration.typeCardBundle ? {} : { typeCardBundleId }),
    ...(registration.viewBundle ? {} : { viewBundleId }),
    ...(registration.builtinOperator ? {} : { builtinOperatorId: operatorId }),
    ...(registration.enabled ? {} : { enabled: true }),
  };
  if (Object.keys(update).length > 0) {
    await api("select the bundles and Operator and enable the document type", {
      method: "PATCH",
      path: `/document-types/${encode(documentType)}`,
      json: { ...update, reason: SEED_REASON },
      ifMatch: registration.etag,
    });
    log(`portal seed: enabled ${documentType}`);
  }
  await inviteBootstrapEmail(runtime, api, log);
  return { documentType };
}
