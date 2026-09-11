export interface TagGroup {
  readonly name: string;
  readonly tags: readonly string[];
}

export interface ReferenceDefinition {
  readonly path: string;
  readonly title: string;
  readonly loadDocument: () => Promise<Record<string, unknown>>;
  readonly tagGroups: readonly TagGroup[];
  readonly operationOrder: readonly string[];
}

export const references: readonly ReferenceDefinition[] = [
  {
    path: "/reference/admin",
    title: "Admin API",
    loadDocument: async () => (await import("@unicas/admin-protocol/openapi.json")).default as Record<string, unknown>,
    tagGroups: [
      { name: "Stack Administration", tags: ["Identity", "Stacks", "Members"] },
      { name: "Capability Configuration", tags: ["OAuth Issuer", "Managed Issuer"] },
      { name: "Application Workflow", tags: ["Playground"] },
      { name: "Audit & Diagnostics", tags: ["Audit", "Root Ref Audit"] },
    ],
    operationOrder: [
      "GET /admin/me", "GET /admin/stacks", "POST /admin/stacks",
      "GET /admin/stacks/{stackId}", "PATCH /admin/stacks/{stackId}",
      "GET /admin/stacks/{stackId}/members", "POST /admin/stacks/{stackId}/member-invitations",
      "POST /admin/member-invitations/{token}/accept", "DELETE /admin/stacks/{stackId}/members",
      "GET /admin/stacks/{stackId}/oauth-issuer", "POST /admin/stacks/{stackId}/oauth-issuer/inspections",
      "PUT /admin/stacks/{stackId}/oauth-issuer", "GET /admin/stacks/{stackId}/managed-issuer",
      "PATCH /admin/stacks/{stackId}/managed-issuer", "POST /admin/stacks/{stackId}/managed-capabilities",
      "GET /admin/stacks/{stackId}/playground/file-roots", "POST /admin/stacks/{stackId}/playground/file-roots",
      "PATCH /admin/stacks/{stackId}/playground/file-roots/{rootId}", "DELETE /admin/stacks/{stackId}/playground/file-roots/{rootId}",
      "GET /admin/stacks/{stackId}/audit-events", "GET /admin/stacks/{stackId}/ref-domains",
      "GET /admin/stacks/{stackId}/root-ref-domains/{refDomain}/refs", "GET /admin/stacks/{stackId}/root-ref-domains/{refDomain}/events",
    ],
  },
  {
    path: "/reference/tenant",
    title: "Tenant API",
    loadDocument: async () => (await import("@unicas/tenant-protocol/openapi.json")).default as Record<string, unknown>,
    tagGroups: [
      { name: "Content Lifecycle", tags: ["Nodes", "Root Refs"] },
      { name: "Operations & Diagnostics", tags: ["Operations"] },
    ],
    operationOrder: [
      "POST /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/lease",
      "GET /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/metadata",
      "GET /stacks/{stackId}/tenants/{tenantId}/cas/nodes/{hash}/content",
      "POST /stacks/{stackId}/tenants/{tenantId}/root-refs",
      "GET /stacks/{stackId}/tenants/{tenantId}/root-refs",
      "GET /stacks/{stackId}/tenants/{tenantId}/cas/usage",
      "POST /stacks/{stackId}/tenants/{tenantId}/cas/gc",
    ],
  },
];

export async function prepareReference(definition: ReferenceDefinition): Promise<Record<string, unknown>> {
  return { ...structuredClone(await definition.loadDocument()), "x-tagGroups": definition.tagGroups };
}