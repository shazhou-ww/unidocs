/**
 * Stand-in for `packages/cloudflare-gateway/src/worker.ts` in the portal
 * runtime test.
 *
 * `bundleTargets` always builds the gateway, and the real gateway entry does
 * not currently bundle: `packages/cloudflare-gateway/src/platform-document-do.ts`
 * imports `cloudflare:workers`, which is not marked external for that entry
 * (commit 21676ea — pre-dates the portal work and is red branch-wide). This
 * test is about the portal worker, not the gateway, so it swaps the gateway
 * entry for this stub via `bundleEntryOverrides`.
 *
 * Delete this file and the override in portal-local-runtime.test.mjs once the
 * gateway entry bundles again.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("gateway stub", { status: 501 });
  },
};
