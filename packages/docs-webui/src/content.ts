import architecture from "./content/architecture.md?raw";
import gettingStarted from "./content/getting-started.md?raw";
import leasesAndRootRefs from "./content/leases-and-root-refs.md?raw";
import oauthIssuer from "./content/oauth-issuer.md?raw";
import operations from "./content/operations.md?raw";

export interface Guide {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly section: "Start" | "Core concepts" | "Administration" | "Operations";
  readonly markdown: string;
}

export const guides: readonly Guide[] = [
  { path: "/unicas/getting-started", title: "Getting started", description: "Choose an access plane and plan a first integration.", section: "Start", markdown: gettingStarted },
  { path: "/unicas/concepts/content-addressing", title: "Content-addressed storage", description: "Immutable nodes, hashes, edges, and tenant isolation.", section: "Core concepts", markdown: architecture },
  { path: "/unicas/concepts/leases-and-root-refs", title: "Leases and Root Refs", description: "Prepare, commit, recover, and release immutable DAG state.", section: "Core concepts", markdown: leasesAndRootRefs },
  { path: "/unicas/administration/oauth-issuer", title: "OAuth issuer activation", description: "Configure capability trust without transferring signing keys.", section: "Administration", markdown: oauthIssuer },
  { path: "/unicas/operations/recovery", title: "Operations and recovery", description: "Retries, idempotency, usage accounting, and garbage collection.", section: "Operations", markdown: operations },
];

export const guideSections = ["Start", "Core concepts", "Administration", "Operations"] as const;