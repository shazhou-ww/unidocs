export interface GatewayIdentity {
  readonly userId: string;
  readonly tenantId: string;
  readonly canManageTenant: boolean;
}

export interface GatewayIdentityResolver {
  resolve(request: Request, requestedTenantId: string): Promise<GatewayIdentity | null>;
}

/** Development compatibility only. Production adapters must use real auth. */
export function createInsecureTenantIdentityResolver(enabled: boolean): GatewayIdentityResolver {
  return {
    async resolve(_request, requestedTenantId) {
      if (!enabled) return null;
      return {
        userId: `local:${requestedTenantId}`,
        tenantId: requestedTenantId,
        canManageTenant: true,
      };
    },
  };
}