export interface GatewayIdentity {
  readonly userId: string;
  readonly tenantId: string;
  readonly canManageTenant: boolean;
}

export interface GatewayIdentityResolver {
  resolve(request: Request, requestedUserId: string): Promise<GatewayIdentity | null>;
}

/** Development compatibility only. Production adapters must use real auth. */
export function createInsecurePathIdentityResolver(enabled: boolean): GatewayIdentityResolver {
  return {
    async resolve(_request, requestedUserId) {
      if (!enabled) return null;
      return {
        userId: requestedUserId,
        tenantId: requestedUserId,
        canManageTenant: true,
      };
    },
  };
}