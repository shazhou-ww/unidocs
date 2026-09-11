import { createContext, useContext } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";

const ClientContext = createContext<TenantPortalClient | null>(null);

export function ClientProvider(props: { client: TenantPortalClient; children: React.ReactNode }) {
  return <ClientContext.Provider value={props.client}>{props.children}</ClientContext.Provider>;
}

export function useClient(): TenantPortalClient {
  const client = useContext(ClientContext);
  if (client === null) throw new Error("useClient must be used inside ClientProvider");
  return client;
}
