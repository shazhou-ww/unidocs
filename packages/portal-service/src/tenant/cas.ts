import { CasCapabilityGrantSchema, type CasCapabilityGrant } from "@unidocs/protocol-tenant-portal";
import { requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

/** The Platform mints these; it never proxies UniCAS node traffic itself. */
export interface CasCapabilityIssuer {
  issue(context: TenantContext): Promise<CasCapabilityGrant>;
}

export function createTenantCasService(issuer: CasCapabilityIssuer, options: { readonly now?: () => number } = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async issue(context: TenantContext, tenantId: string): Promise<CasCapabilityGrant> {
      requireTenantScope(context, tenantId);
      const parsed = CasCapabilityGrantSchema.safeParse(await issuer.issue(context));
      if (!parsed.success) throw new TenantOperationError("unavailable");
      if (parsed.data.tenantId !== context.tenantId) throw new TenantOperationError("forbidden");
      if (parsed.data.expiresAt <= now()) throw new TenantOperationError("unavailable");
      return parsed.data;
    },
  };
}
