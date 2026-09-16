import { createContext, useContext } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import type { DraftScope } from "./drafts/draft-store.js";

const ClientContext = createContext<TenantPortalClient | null>(null);
const DraftScopeContext = createContext<DraftScope | null>(null);

export function ClientProvider(props: { client: TenantPortalClient; draftScope: DraftScope; children: React.ReactNode }) {
  return (
    <ClientContext.Provider value={props.client}>
      <DraftScopeContext.Provider value={props.draftScope}>{props.children}</DraftScopeContext.Provider>
    </ClientContext.Provider>
  );
}

export function useClient(): TenantPortalClient {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useClient must be used inside ClientProvider");
  return client;
}

/** 草稿按「租户 + principal」存，谁登录就只看到谁的。 */
export function useDraftScope(): DraftScope {
  const scope = useContext(DraftScopeContext);
  if (scope === null) throw new Error("useDraftScope must be used inside ClientProvider");
  return scope;
}
