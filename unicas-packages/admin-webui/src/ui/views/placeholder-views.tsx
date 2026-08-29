import { Card, NotAvailableState } from "../components.js";

export function RootRefAuditView({ stackId }: { stackId: string }) {
  void stackId;
  return (
    <Card title="Root Ref audit">
      <NotAvailableState
        title="Audit data is not available yet"
        detail="The admin UI is not yet wired to the private tenant audit reader. This view will list domain balances and the ordered event log after that connection is enabled."
      />
    </Card>
  );
}

export function UsageView({ stackId }: { stackId: string }) {
  void stackId;
  return (
    <Card title="Usage">
      <NotAvailableState
        title="Usage is a tenant-plane read"
        detail="Tenant usage requires a cas:manage capability for a specific tenant. The admin session deliberately carries no tenant credential, so an explicit delegated path is required before this view can query usage."
      />
    </Card>
  );
}
