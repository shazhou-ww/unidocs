import type { CasNodeCache, HttpFetcher } from "./types.js";

export type LegacyTenantCasClientConfig =
  | {
    readonly baseUrl: string;
    readonly tenantId: string;
    readonly getToken?: () => Promise<string>;
    readonly cache?: CasNodeCache;
  }
  | {
    readonly fetcher: HttpFetcher;
    readonly tenantId: string;
    readonly accessKey: string;
  }
  | {
    readonly fetcher: HttpFetcher;
    readonly tenantId: string;
    readonly getToken: () => Promise<string>;
  };