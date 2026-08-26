import { Card, NotAvailableState } from "../components.js";

/**
 * Root Ref audit balances/events render against the frozen admin contracts;
 * the tenant-side audit reader and domain tables land in Tasks 5–7. Until
 * then the BFF returns SERVICE_UNAVAILABLE, which this view surfaces as a
 * documented empty state.
 */
export function RootRefAuditView({ stackId }: { stackId: string }) {
  void stackId;
  return (
    <Card title="Root Ref audit">
      <NotAvailableState
        title="Audit data is not available yet"
        detail="The tenant-side Root Ref audit reader is implemented in a later phase (Task 5–7). This view will list domain balances and the ordered event log once the reader is wired."
      />
    </Card>
  );
}

/**
 * Tenant usage (cas:usage:read) is a tenant-plane capability; the admin plane
 * holds no tenant credential. Wired into the console in Task 4/8.
 */
export function UsageView({ stackId }: { stackId: string }) {
  void stackId;
  return (
    <Card title="Usage">
      <NotAvailableState
        title="Usage is a tenant-plane read"
        detail="Tenant usage requires a tenant capability (cas:usage:read); the admin console has no tenant credential. This view is wired after the tenant authorization tasks."
      />
    </Card>
  );
}
