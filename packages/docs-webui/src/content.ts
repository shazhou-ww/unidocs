import architecture from "./content/architecture.md?raw";
import gettingStarted from "./content/getting-started.md?raw";
import leasesAndRootRefs from "./content/leases-and-root-refs.md?raw";
import oauthIssuer from "./content/oauth-issuer.md?raw";
import operations from "./content/operations.md?raw";
import unidocsAdminSecurity from "./content/unidocs/admin-security.md?raw";
import unidocsAudit from "./content/unidocs/audit.md?raw";
import unidocsBindAndEnable from "./content/unidocs/bind-and-enable.md?raw";
import unidocsCandidateBindings from "./content/unidocs/candidates-and-bindings.md?raw";
import unidocsDocumentContracts from "./content/unidocs/document-contracts.md?raw";
import unidocsEvolveFormat from "./content/unidocs/evolve-format.md?raw";
import unidocsIntroduction from "./content/unidocs/introduction.md?raw";
import unidocsOperatorProtocol from "./content/unidocs/operator-protocol.md?raw";
import unidocsRegisterFormat from "./content/unidocs/register-format.md?raw";
import unidocsReplaceOperator from "./content/unidocs/replace-operator.md?raw";
import unidocsResponsibilities from "./content/unidocs/admin-responsibilities.md?raw";
import unidocsTroubleshoot from "./content/unidocs/troubleshoot-enablement.md?raw";
import unidocsTypeCardBundle from "./content/unidocs/type-card-bundle.md?raw";
import unidocsUpdatePresentation from "./content/unidocs/update-presentation.md?raw";
import unidocsViewBundle from "./content/unidocs/view-bundle.md?raw";

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

  { product: "unidocs", path: "/unidocs/introduction", title: "What is UniDocs?", description: "The Platform, View, Operator, and storage responsibilities.", section: "Introduction", markdown: unidocsIntroduction },
  { product: "unidocs", path: "/unidocs/administrators", title: "What administrators manage", description: "The resources that form a complete document experience.", section: "Introduction", markdown: unidocsResponsibilities },

  { product: "unidocs", path: "/unidocs/register-format", title: "Registration workflow", description: "Register one document format from draft through enablement.", section: "Register a document format", markdown: unidocsRegisterFormat },

  { product: "unidocs", path: "/unidocs/concepts/document-types", title: "Document types and lifecycle", description: "Create drafts, select compatible resources, and enable formats.", section: "Core concepts", markdown: unidocsBindAndEnable },
  { product: "unidocs", path: "/unidocs/concepts/document-contracts", title: "Document Contracts", description: "Pair snapshot and location schemas in append-only revisions.", section: "Core concepts", markdown: unidocsDocumentContracts },
  { product: "unidocs", path: "/unidocs/concepts/type-card-bundles", title: "Type Card bundles", description: "Package localized creation-card content and assets.", section: "Core concepts", markdown: unidocsTypeCardBundle },
  { product: "unidocs", path: "/unidocs/concepts/view-bundles", title: "View bundles", description: "Package interactive and thumbnail browser entrypoints.", section: "Core concepts", markdown: unidocsViewBundle },
  { product: "unidocs", path: "/unidocs/concepts/operators", title: "Operators", description: "Expose discovery and pass a user-data-free validation.", section: "Core concepts", markdown: unidocsOperatorProtocol },
  { product: "unidocs", path: "/unidocs/concepts/candidates-and-bindings", title: "Candidates and current bindings", description: "Separate upload and validation from production selection.", section: "Core concepts", markdown: unidocsCandidateBindings },

  { product: "unidocs", path: "/unidocs/scenarios/evolve-format", title: "Evolve a document format", description: "Append a contract revision without invalidating history.", section: "Common scenarios", markdown: unidocsEvolveFormat },
  { product: "unidocs", path: "/unidocs/scenarios/update-presentation", title: "Update presentation", description: "Replace Type Card or View resources without changing schemas.", section: "Common scenarios", markdown: unidocsUpdatePresentation },
  { product: "unidocs", path: "/unidocs/scenarios/replace-operator", title: "Replace an Operator", description: "Validate and bind a replacement while preserving compatibility.", section: "Common scenarios", markdown: unidocsReplaceOperator },
  { product: "unidocs", path: "/unidocs/scenarios/disable-and-repair", title: "Disable and repair a format", description: "Contain a problem, repair candidates, and re-enable safely.", section: "Common scenarios", markdown: unidocsTroubleshoot },
  { product: "unidocs", path: "/unidocs/scenarios/investigate-audit", title: "Investigate audit events", description: "Trace configuration changes and validation failures.", section: "Common scenarios", markdown: unidocsAudit },

  { product: "unidocs", path: "/unidocs/administration/security", title: "Authentication and safe writes", description: "Authentication, CSRF, idempotency, ETags, and membership.", section: "Administration", markdown: unidocsAdminSecurity },
];

export const guideSections: Readonly<Record<ProductId, readonly string[]>> = {
  unicas: ["Start", "Core concepts", "Administration", "Operations"],
  unidocs: ["Introduction", "Register a document format", "Core concepts", "Common scenarios", "Administration"],
};
