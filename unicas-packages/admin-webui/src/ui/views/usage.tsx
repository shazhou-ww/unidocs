import { Card, NotAvailableState } from "../components.js";

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