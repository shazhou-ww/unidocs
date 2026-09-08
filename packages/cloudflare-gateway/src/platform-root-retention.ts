import { createTenantCasClient } from "@unicas/tenant-client";
import type { HttpFetcher } from "@unicas/tenant-client";
import type { PlatformRootRetentionPort } from "./platform-commit-coordinator.js";

export interface PlatformRootRetentionOptions {
  readonly stackId: string;
  readonly tenantId: string;
  readonly fetcher: HttpFetcher;
  readonly getAuthorization: () => Promise<string>;
}

export function createPlatformRootRetention(options: PlatformRootRetentionOptions): PlatformRootRetentionPort {
  if (options.stackId.length === 0 || options.tenantId.length === 0) throw new TypeError("Platform CAS identity is required");
  const cas = createTenantCasClient({
    baseUrl: "https://cas.internal",
    stackId: options.stackId,
    tenantId: options.tenantId,
    fetcher: options.fetcher,
    getToken: async () => {
      const authorization = await options.getAuthorization();
      if (!/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw new Error("Invalid platform CAS authorization");
      return authorization.slice(7);
    },
  });
  return {
    async retainRoot(input) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.stateHash)) {
        throw new TypeError("Invalid platform root retention");
      }
      const result = await cas.updateRootRefs({ requestId: input.requestId, changes: { [input.stateHash]: 1 } });
      if (result.success !== true) throw new Error("Platform root retention failed");
    },
  };
}