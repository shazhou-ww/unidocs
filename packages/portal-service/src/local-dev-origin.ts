/**
 * Loopback only, and only the two spellings a local runtime binds. A hostname
 * that merely starts with 127.0.0.1 is a different host, so this matches the
 * whole authority rather than a prefix, and requires an explicit port so a
 * bare `http://127.0.0.1` cannot slip through.
 *
 * Lives here, in the cloud-neutral core, rather than in the Cloudflare adapter
 * that first needed it: the rule is enforced at five sites now — the portal's
 * Google config, its session auth, its login round trip, and the type-card
 * and view bundle origins in `admin/type-card-bundles.ts` and
 * `admin/view-bundles.ts`. The bundle ones are in this package, which cannot
 * import from the adapter, and writing the rule a second time is what let the
 * earlier three drift apart.
 */
export const LOCAL_DEV_ORIGIN_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

/**
 * True only for a *canonical* loopback origin. Self-safe on purpose: the call
 * sites each run their own `new URL(x).origin !== x` first, and they keep
 * doing so, but this is exported API and the whole point of exporting it is
 * that another site will call it. A site that trusts the name alone must not
 * accept `http://127.0.0.1:8795@evil.test`, so the canonicality the callers
 * supply is enforced here too rather than assumed.
 *
 * Consequence worth knowing: a spelling whose canonical form differs is now
 * false even when the pattern matches it — `http://127.0.0.1:99999` (port out
 * of range, `new URL` throws) and `http://127.0.0.1:80` (canonically
 * `http://127.0.0.1`, which the pattern rejects for having no port). Both are
 * narrowings; the runtime only ever binds an explicit high port.
 */
export function isLocalDevOrigin(origin: string): boolean {
  if (!LOCAL_DEV_ORIGIN_PATTERN.test(origin)) return false;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}
