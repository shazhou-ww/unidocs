/**
 * Registry of locally runnable portal components, plus the pure helpers that
 * expand a selection into worker and frontend descriptors.
 *
 * A *target* is what a user types (`pnpm dev portal`); a *component* is one
 * process. `portal` is an umbrella: it owns the backend service today, and the
 * admin and tenant WebUIs join it by adding rows here rather than by growing a
 * second selector.
 *
 * Deliberately dependency-free, for the same reason `doc-types.mjs` is: argv is
 * validated against this table before anything heavy is imported.
 */

/** Portal backend; kept clear of the gateway/doc-type band (8787-8790). */
export const PORTAL_PORT = 8795;

/**
 * Where the portal serves type-card bundle objects.
 *
 * It must not be `PORTAL_PORT`: `worker.ts` decides a request is a bundle
 * fetch by comparing `new URL(request.url).origin` against `BUNDLE_ORIGIN`, so
 * one origin for both would answer every portal request out of the R2 bucket.
 * Production gives it a separate hostname on the same worker; locally that is
 * a second port on the same worker.
 */
export const PORTAL_BUNDLE_PORT = 8796;

export const SERVICE_TARGETS = {
  portal: [
    {
      name: "portal",
      target: "portal",
      entry: "packages/cloudflare-portal/src/worker.ts",
      worker: "unidocs-portal",
      outfile: "portal.js",
      port: PORTAL_PORT,
      /** Applied by the runtime; Miniflare has no migrations runner of its own. */
      migrations: "packages/cloudflare-portal/migrations",
      d1Binding: "DB",
      /** Type-card bundle objects: an R2 bucket reached on its own origin. */
      r2Binding: "BUNDLES",
      bundlePort: PORTAL_BUNDLE_PORT,
      /**
       * Browser entry points this worker serves, printed by `pnpm dev`.
       * Neither is discoverable from the port alone: both WebUIs are mounted
       * under a base path, so the bare origin is a 404.
       */
      consoles: [
        { label: "admin", path: "/admin/" },
        { label: "tenant", path: "/portal/" },
      ],
    },
    // No frontend rows: both WebUIs are compiled into the worker above
    // (`build:webui` -> src/*-ui-assets.generated.ts) and served from its own
    // origin at /admin/ and /portal/. They are not separate dev servers,
    // because the admin OAuth callback is pinned to PORTAL_ORIGIN and a UI on
    // another port would be cut out of the login round trip.
  ],
};

export function expandServiceTarget(name) {
  const components = SERVICE_TARGETS[name];
  if (!components) {
    throw new Error(`Unknown service target: ${name}. Available: ${Object.keys(SERVICE_TARGETS).join(", ")}`);
  }
  return components;
}

/** Components of the selected targets that run as a Miniflare worker. */
export function serviceWorkers(names) {
  return names.flatMap(expandServiceTarget).filter(component => component.entry);
}

/** Components of the selected targets that run as a Vite dev server. */
export function serviceFrontends(names) {
  return names.flatMap(expandServiceTarget).filter(component => component.web);
}

/**
 * Which stacks can run a given target, and what is missing when they cannot.
 *
 * Keyed by target name and *not* derived from `SERVICE_TARGETS`: a row here is
 * a claim about an adapter existing, which the registry cannot know. Exported
 * so the coverage guard in `tests/unit/scripts/services.test.mjs` can check the
 * two tables name the same targets — a registered target with no row here is
 * refused by `assertServicesAvailable` with "no adapter is registered", which
 * is the opposite of the truth.
 */
export const SERVICE_PLATFORMS = {
  portal: { cloudflare: true, azure: "packages/azure-portal does not exist yet" },
};

export function assertServicesAvailable(platform, names) {
  for (const name of names) {
    const support = SERVICE_PLATFORMS[name]?.[platform];
    if (support === true) continue;
    throw new Error(
      `${name} is not available on the unidocs-${platform} stack yet (${support ?? "no adapter is registered"}).`,
    );
  }
}
