import architecture from "./content/architecture.md?raw";
import gettingStarted from "./content/getting-started.md?raw";
import leasesAndRootRefs from "./content/leases-and-root-refs.md?raw";
import oauthIssuer from "./content/oauth-issuer.md?raw";
import operations from "./content/operations.md?raw";
import unidocsAdminSecurity from "./content/unidocs/admin-security.md?raw";
import unidocsBundles from "./content/unidocs/bundles-and-operators.md?raw";
import unidocsDocumentTypes from "./content/unidocs/document-types.md?raw";
import unidocsGettingStarted from "./content/unidocs/getting-started.md?raw";
import unidocsDocumentContracts from "./content/unidocs/document-contracts.md?raw";

export type ProductId = "unicas" | "unidocs";

export interface ProductDefinition {
  readonly id: ProductId;
  readonly name: string;
  readonly mark: string;
  readonly homePath: string;
  readonly externalLabel: string;
  readonly externalUrl: string;
  readonly footerLabel: string;
  readonly footerUrl: string;
}

export const products: Readonly<Record<ProductId, ProductDefinition>> = {
  unicas: {
    id: "unicas",
    name: "UniCAS",
    mark: "U",
    homePath: "/unicas",
    externalLabel: "Open Admin Portal",
    externalUrl: "https://unicas.shazhou.work/admin/",
    footerLabel: "UniCAS service",
    footerUrl: "https://unicas.shazhou.work",
  },
  unidocs: {
    id: "unidocs",
    name: "UniDocs",
    mark: "D",
    homePath: "/unidocs",
    externalLabel: "Open UniDocs",
    externalUrl: "https://unidocs.shazhou.work/",
    footerLabel: "UniDocs",
    footerUrl: "https://unidocs.shazhou.work",
  },
};

export interface Guide {
  readonly product: ProductId;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly section: string;
  readonly markdown: string;
}

export const guides: readonly Guide[] = [
  { product: "unicas", path: "/unicas/getting-started", title: "Getting started", description: "Choose an access plane and plan a first integration.", section: "Start", markdown: gettingStarted },
  { product: "unicas", path: "/unicas/concepts/content-addressing", title: "Content-addressed storage", description: "Immutable nodes, hashes, edges, and tenant isolation.", section: "Core concepts", markdown: architecture },
  { product: "unicas", path: "/unicas/concepts/leases-and-root-refs", title: "Leases and Root Refs", description: "Prepare, commit, recover, and release immutable DAG state.", section: "Core concepts", markdown: leasesAndRootRefs },
  { product: "unicas", path: "/unicas/administration/oauth-issuer", title: "OAuth issuer activation", description: "Configure capability trust without transferring signing keys.", section: "Administration", markdown: oauthIssuer },
  { product: "unicas", path: "/unicas/operations/recovery", title: "Operations and recovery", description: "Retries, idempotency, usage accounting, and garbage collection.", section: "Operations", markdown: operations },
  { product: "unidocs", path: "/unidocs/getting-started", title: "Admin control plane", description: "Understand the UniDocs administrator workflow and resource model.", section: "Start", markdown: unidocsGettingStarted },
  { product: "unidocs", path: "/unidocs/configuration/document-types", title: "Document type lifecycle", description: "Create drafts, bind compatible resources, and enable a document type.", section: "Configuration model", markdown: unidocsDocumentTypes },
  { product: "unidocs", path: "/unidocs/configuration/document-contracts", title: "Document Contracts", description: "Pair snapshot and location schemas in append-only revisions.", section: "Configuration model", markdown: unidocsDocumentContracts },
  { product: "unidocs", path: "/unidocs/configuration/bundles-and-operators", title: "Bundles and Operators", description: "Upload immutable presentation bundles and validate processing candidates.", section: "Configuration model", markdown: unidocsBundles },
  { product: "unidocs", path: "/unidocs/administration/security", title: "Admin security and retries", description: "Sessions, CSRF, idempotency, ETags, and membership safeguards.", section: "Administration", markdown: unidocsAdminSecurity },
];

export const guideSections: Readonly<Record<ProductId, readonly string[]>> = {
  unicas: ["Start", "Core concepts", "Administration", "Operations"],
  unidocs: ["Start", "Configuration model", "Administration"],
};