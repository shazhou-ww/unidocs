import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let miniflare;
let database;

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-membership-spike",
    modules: true,
    script: "export default { fetch() { return new Response('spike'); } };",
    compatibilityDate: "2026-08-18",
    d1Databases: { DB: `portal-membership-${crypto.randomUUID()}` },
  }] }));
  database = await miniflare.getD1Database("DB", "portal-membership-spike");
  await database.batch([
    database.prepare("CREATE TABLE bootstrap_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))"),
    database.prepare("CREATE TABLE members (id TEXT PRIMARY KEY, email TEXT NOT NULL, issuer TEXT, subject TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), revision INTEGER NOT NULL DEFAULT 0, CHECK ((issuer IS NULL) = (subject IS NULL)))"),
    database.prepare("CREATE UNIQUE INDEX active_email ON members (email) WHERE active = 1"),
    database.prepare("CREATE UNIQUE INDEX active_identity ON members (issuer, subject) WHERE active = 1 AND subject IS NOT NULL"),
    database.prepare("CREATE TABLE sessions (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id))"),
    database.prepare("CREATE TABLE audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id))"),
    database.prepare("CREATE TABLE receipts (actor TEXT NOT NULL, key TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (actor, key))"),
    database.prepare("CREATE TABLE mutation_guard (valid INTEGER NOT NULL CHECK (valid = 1))"),
  ]);
});

afterEach(async () => { await miniflare?.dispose(); });

function guard() {
  return [database.prepare("INSERT INTO mutation_guard VALUES (changes())"), database.prepare("DELETE FROM mutation_guard")];
}

function bootstrap(id, email, subject, auditId = crypto.randomUUID()) {
  return database.batch([
    database.prepare("INSERT INTO bootstrap_state VALUES (1)"),
    database.prepare("INSERT INTO members (id, email, issuer, subject) VALUES (?, ?, 'https://accounts.google.com', ?)").bind(id, email, subject),
    database.prepare("INSERT INTO audit VALUES (?, 'administrator.bootstrap', ?)").bind(auditId, id),
  ]);
}

function bindIdentity(email, subject, auditId = crypto.randomUUID()) {
  return database.batch([
    database.prepare("UPDATE members SET issuer = 'https://accounts.google.com', subject = ?, revision = revision + 1 WHERE email = ? AND active = 1 AND subject IS NULL").bind(subject, email),
    ...guard(),
    database.prepare("INSERT INTO audit SELECT ?, 'administrator.bound', id FROM members WHERE email = ? AND active = 1").bind(auditId, email),
  ]);
}

function removeMember(actor, target, revision = 0, auditId = crypto.randomUUID(), key = crypto.randomUUID()) {
  return database.batch([
    database.prepare("INSERT INTO receipts SELECT id, ?, ? FROM members WHERE id = ? AND active = 1 AND subject IS NOT NULL").bind(key, target, actor),
    ...guard(),
    database.prepare(`UPDATE members SET active = 0, revision = revision + 1
      WHERE id = ? AND id != ? AND active = 1 AND revision = ?
      AND (subject IS NULL OR (SELECT COUNT(*) FROM members WHERE active = 1 AND subject IS NOT NULL) > 1)`).bind(target, actor, revision),
    ...guard(),
    database.prepare("DELETE FROM sessions WHERE member_id = ?").bind(target),
    database.prepare("INSERT INTO audit VALUES (?, 'administrator.removed', ?)").bind(auditId, target),
  ]);
}

async function invite(id, email) {
  await database.prepare("INSERT INTO members (id, email) VALUES (?, ?)").bind(id, email).run();
}

async function activeMembers() {
  return (await database.prepare("SELECT id FROM members WHERE active = 1 ORDER BY id").all()).results.map(member => member.id);
}

describe("Portal Phase 0: administrator authority in D1", () => {
  test("concurrent bootstrap admits one identity and one audit event", async () => {
    const results = await Promise.allSettled([
      bootstrap("first", "first@example.com", "first-subject"),
      bootstrap("second", "second@example.com", "second-subject"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await activeMembers()).toHaveLength(1);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM audit").first("count")).toBe(1);
    await database.prepare("UPDATE members SET active = 0").run();
    await expect(bootstrap("third", "third@example.com", "third-subject")).rejects.toThrow();
  });

  test("failed bootstrap rolls back the persistent single-use marker", async () => {
    await invite("occupied", "occupied@example.com");
    await expect(bootstrap("occupied", "first@example.com", "first-subject")).rejects.toThrow();
    expect(await database.prepare("SELECT COUNT(*) AS count FROM bootstrap_state").first("count")).toBe(0);
    await bootstrap("first", "first@example.com", "first-subject");
  });

  test("only one subject can claim an invited email and an identity cannot claim two members", async () => {
    await invite("invited", "invited@example.com");
    const results = await Promise.allSettled([
      bindIdentity("invited@example.com", "subject-one"),
      bindIdentity("invited@example.com", "subject-two"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const subject = await database.prepare("SELECT subject FROM members WHERE id = 'invited'").first("subject");
    await invite("other", "other@example.com");
    await expect(bindIdentity("other@example.com", subject)).rejects.toThrow();
    expect(await database.prepare("SELECT subject FROM members WHERE id = 'other'").first("subject")).toBeNull();
    expect(await database.prepare("SELECT COUNT(*) AS count FROM audit").first("count")).toBe(1);
  });

  test("binding audit failure rolls back the identity and revision", async () => {
    await bootstrap("first", "first@example.com", "first", "occupied-audit");
    await invite("invited", "invited@example.com");
    await expect(bindIdentity("invited@example.com", "invited", "occupied-audit")).rejects.toThrow();
    expect(await database.prepare("SELECT subject, revision FROM members WHERE id = 'invited'").first()).toEqual({ subject: null, revision: 0 });
  });

  test("self-removal and invited actors cannot remove the last bound administrator", async () => {
    await bootstrap("first", "first@example.com", "first");
    await invite("invited", "invited@example.com");
    await expect(removeMember("first", "first")).rejects.toThrow();
    await expect(removeMember("invited", "first")).rejects.toThrow();
    expect(await activeMembers()).toEqual(["first", "invited"]);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM receipts").first("count")).toBe(0);
  });

  test("mutual removal leaves one bound administrator and rejects the already-authenticated loser", async () => {
    await bootstrap("first", "first@example.com", "first");
    await invite("second", "second@example.com");
    await bindIdentity("second@example.com", "second");
    await database.prepare("INSERT INTO sessions VALUES ('first-hash', 'first'), ('second-hash', 'second')").run();
    const results = await Promise.allSettled([
      removeMember("first", "second", 1),
      removeMember("second", "first", 0),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const [survivor] = await activeMembers();
    const removed = survivor === "first" ? "second" : "first";
    expect(await database.prepare("SELECT member_id FROM sessions").first("member_id")).toBe(survivor);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM receipts").first("count")).toBe(1);
    await expect(removeMember(removed, survivor)).rejects.toThrow();
    await invite("third", "third@example.com");
    await expect(removeMember(removed, "third")).rejects.toThrow();
  });

  test("stale revision and audit failure preserve membership, session and receipts", async () => {
    await bootstrap("first", "first@example.com", "first", "occupied-audit");
    await invite("second", "second@example.com");
    await bindIdentity("second@example.com", "second");
    await database.prepare("INSERT INTO sessions VALUES ('second-hash', 'second')").run();
    await expect(removeMember("first", "second", 0)).rejects.toThrow();
    await expect(removeMember("first", "second", 1, "occupied-audit")).rejects.toThrow();
    expect(await activeMembers()).toEqual(["first", "second"]);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM sessions").first("count")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM receipts").first("count")).toBe(0);
  });

  test("reinviting a removed email creates a new principal without reviving old sessions", async () => {
    await bootstrap("first", "first@example.com", "first");
    await invite("second", "second@example.com");
    await bindIdentity("second@example.com", "second-subject");
    await database.prepare("INSERT INTO sessions VALUES ('old-session', 'second')").run();
    await removeMember("first", "second", 1);
    await invite("replacement", "second@example.com");
    await bindIdentity("second@example.com", "second-subject");
    expect(await database.prepare("SELECT COUNT(*) AS count FROM sessions").first("count")).toBe(0);
    await expect(removeMember("second", "replacement", 1)).rejects.toThrow();
    expect(await activeMembers()).toEqual(["first", "replacement"]);
  });
});

describe("Portal Phase 0: session and login transaction lifecycle", () => {
  beforeEach(async () => {
    await bootstrap("first", "first@example.com", "first");
    await database.batch([
      database.prepare("CREATE TABLE session_families (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), revoked INTEGER NOT NULL DEFAULT 0)"),
      database.prepare("CREATE TABLE rotating_sessions (hash TEXT PRIMARY KEY, family_id TEXT NOT NULL UNIQUE REFERENCES session_families(id), expires_at INTEGER NOT NULL)"),
      database.prepare("CREATE TABLE login_transactions (state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
      database.prepare("INSERT INTO session_families (id, member_id) VALUES ('family', 'first')"),
      database.prepare("INSERT INTO rotating_sessions VALUES ('old-hash', 'family', 2000)"),
    ]);
  });

  function rotate(nextHash, now = 1000, auditId = crypto.randomUUID()) {
    return database.batch([
      database.prepare(`DELETE FROM rotating_sessions WHERE hash = 'old-hash' AND family_id = 'family' AND expires_at > ?
        AND EXISTS (SELECT 1 FROM session_families AS family JOIN members AS member ON member.id = family.member_id
          WHERE family.id = 'family' AND family.revoked = 0 AND member.active = 1 AND member.subject IS NOT NULL)`).bind(now),
      ...guard(),
      database.prepare("INSERT INTO rotating_sessions VALUES (?, 'family', ?)").bind(nextHash, now + 28_800),
      database.prepare("INSERT INTO audit VALUES (?, 'session.rotated', 'first')").bind(auditId),
    ]);
  }

  async function logout() {
    await database.batch([
      database.prepare("UPDATE session_families SET revoked = 1 WHERE id = 'family'"),
      database.prepare("DELETE FROM rotating_sessions WHERE family_id = 'family'"),
    ]);
  }

  test("concurrent reauthentication consumes an old session only once", async () => {
    const results = await Promise.allSettled([rotate("new-left"), rotate("new-right")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM rotating_sessions").first("count")).toBe(1);
    expect(await database.prepare("SELECT hash FROM rotating_sessions").first("hash")).not.toBe("old-hash");
    await expect(rotate("replay")).rejects.toThrow();
  });

  test("logout racing with rotation leaves no usable successor", async () => {
    await Promise.allSettled([rotate("next-hash"), logout()]);
    expect(await database.prepare("SELECT revoked FROM session_families WHERE id = 'family'").first("revoked")).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM rotating_sessions").first("count")).toBe(0);
    await expect(rotate("after-logout")).rejects.toThrow();
  });

  test("expired sessions and revoked members cannot rotate, and audit failure preserves the old session", async () => {
    await expect(rotate("expired", 2000)).rejects.toThrow();
    const auditId = await database.prepare("SELECT id FROM audit LIMIT 1").first("id");
    await expect(rotate("failed-audit", 1000, auditId)).rejects.toThrow();
    expect(await database.prepare("SELECT hash FROM rotating_sessions").first("hash")).toBe("old-hash");
    await database.prepare("UPDATE members SET active = 0 WHERE id = 'first'").run();
    await expect(rotate("removed-member")).rejects.toThrow();
  });

  test("login state is browser-bound, expires, and is consumed once under concurrent callbacks", async () => {
    await database.prepare("INSERT INTO login_transactions VALUES ('state-hash', 'browser-hash', 2000)").run();
    const take = (browserHash, now) => database.prepare("DELETE FROM login_transactions WHERE state_hash = 'state-hash' AND browser_hash = ? AND expires_at > ? RETURNING state_hash")
      .bind(browserHash, now).first();
    expect(await take("wrong-browser", 1000)).toBeNull();
    expect(await take("browser-hash", 2000)).toBeNull();
    const results = await Promise.all([take("browser-hash", 1000), take("browser-hash", 1000)]);
    expect(results.filter(Boolean)).toEqual([{ state_hash: "state-hash" }]);
    expect(await take("browser-hash", 1000)).toBeNull();
  });
});