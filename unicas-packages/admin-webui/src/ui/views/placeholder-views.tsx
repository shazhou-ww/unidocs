import { useCallback, useEffect, useState } from "react";
import { ChevronsDown, Filter } from "lucide-react";
import type { CasRefDomain, CasRootRefBalance, CasRootRefEvent } from "@unicas/admin-client";
import { api } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, NotAvailableState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

interface RefPage {
  readonly revision: number;
  readonly refs: readonly CasRootRefBalance[];
  readonly nextCursor: string | null;
}

interface EventPage {
  readonly events: readonly CasRootRefEvent[];
  readonly latestRevision: number;
  readonly nextAfter: number;
}

export function RootRefAuditView({ stackId }: { stackId: string }) {
  const [domains, setDomains] = useState<readonly CasRefDomain[] | null>(null);
  const [domain, setDomain] = useState("");
  const [tenantInput, setTenantInput] = useState("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [refs, setRefs] = useState<RefPage | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setDomains(null);
    setCatalogError(null);
    void api<{ domains: readonly CasRefDomain[] }>(`/admin/stacks/${encodeURIComponent(stackId)}/ref-domains`)
      .then((result) => {
        if (!active) return;
        setDomains(result.domains);
        setDomain((current) => result.domains.some((item) => item.refDomain === current)
          ? current
          : (result.domains[0]?.refDomain ?? ""));
      })
      .catch((caught) => {
        if (active) setCatalogError(formatErrorSafe(caught));
      });
    return () => { active = false; };
  }, [stackId]);

  const queryPrefix = tenantFilter ? `tenantId=${encodeURIComponent(tenantFilter)}&` : "";
  const domainPath = `/admin/stacks/${encodeURIComponent(stackId)}/root-ref-domains/${encodeURIComponent(domain)}`;

  const loadRefs = useCallback(async (cursor: string | null, append: boolean) => {
    if (!domain) return;
    setRefsLoading(true);
    setRefsError(null);
    try {
      const result = await api<RefPage>(`${domainPath}/refs?${queryPrefix}limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      setRefs((previous) => append && previous
        ? { ...result, refs: [...previous.refs, ...result.refs] }
        : result);
    } catch (caught) {
      setRefsError(formatErrorSafe(caught));
    } finally {
      setRefsLoading(false);
    }
  }, [domain, domainPath, queryPrefix]);

  const loadEvents = useCallback(async (after: number, append: boolean) => {
    if (!domain) return;
    setEventsLoading(true);
    setEventsError(null);
    try {
      const result = await api<EventPage>(`${domainPath}/events?${queryPrefix}limit=50&after=${after}`);
      setEvents((previous) => append && previous
        ? { ...result, events: [...previous.events, ...result.events] }
        : result);
    } catch (caught) {
      setEventsError(formatErrorSafe(caught));
    } finally {
      setEventsLoading(false);
    }
  }, [domain, domainPath, queryPrefix]);

  useEffect(() => {
    setRefs(null);
    setEvents(null);
    if (!domain) return;
    void loadRefs(null, false);
    void loadEvents(0, false);
  }, [domain, loadEvents, loadRefs]);

  if (catalogError) return <Card title="Root Ref audit"><ErrorState message={catalogError} /></Card>;
  if (domains === null) return <Card title="Root Ref audit"><LoadingState label="Loading ref domains…" /></Card>;
  if (domains.length === 0) {
    return <Card title="Root Ref audit"><EmptyState message="No Root Ref domains have been observed yet." /></Card>;
  }

  return (
    <>
      <Card title="Root Ref audit">
        <div className="audit-filters">
          <div className="field-row">
            <label htmlFor="root-ref-domain">Ref domain</label>
            <select id="root-ref-domain" value={domain} onChange={(event) => setDomain(event.target.value)}>
              {domains.map((item) => <option key={item.refDomain} value={item.refDomain}>{item.refDomain}</option>)}
            </select>
          </div>
          <div className="field-row">
            <label htmlFor="root-ref-tenant">Tenant ID (optional)</label>
            <div className="inline-form">
              <input
                id="root-ref-tenant"
                value={tenantInput}
                placeholder="All tenants"
                onChange={(event) => setTenantInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setTenantFilter(tenantInput.trim());
                }}
              />
              <Button icon={<Filter size={15} />} onClick={() => setTenantFilter(tenantInput.trim())}>Apply filter</Button>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Current balances">
        {refs ? <p className="hint">Snapshot revision {refs.revision.toLocaleString()}</p> : null}
        {refsError ? <ErrorState message={refsError} /> : null}
        {refs === null && !refsError ? <LoadingState label="Loading balances…" /> : null}
        {refs ? (
          <>
            <Table
              columns={["Tenant", "Hash", "Count"]}
              empty="No balances match this filter."
              rows={refs.refs.map((ref) => [
                <code key={`tenant-${ref.tenantId}-${ref.hash}`}>{ref.tenantId}</code>,
                <code key={`hash-${ref.tenantId}-${ref.hash}`}>{ref.hash}</code>,
                ref.count.toLocaleString(),
              ])}
            />
            {refs.nextCursor ? (
              <Button icon={<ChevronsDown size={15} />} onClick={() => void loadRefs(refs.nextCursor, true)} disabled={refsLoading}>
                {refsLoading ? "Loading…" : "Load more balances"}
              </Button>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card title="Ordered events">
        {events ? <p className="hint">Latest revision {events.latestRevision.toLocaleString()}</p> : null}
        {eventsError ? <ErrorState message={eventsError} /> : null}
        {events === null && !eventsError ? <LoadingState label="Loading events…" /> : null}
        {events ? (
          <>
            <Table
              columns={["Revision", "Applied", "Tenant", "Request ID", "Changes"]}
              empty="No events match this filter."
              rows={events.events.map((event) => [
                event.revision.toLocaleString(),
                new Date(event.appliedAt).toLocaleString(),
                <code key={`event-tenant-${event.revision}`}>{event.tenantId}</code>,
                <code key={`request-${event.revision}`}>{event.requestId}</code>,
                <div className="ref-changes" key={`changes-${event.revision}`}>
                  {Object.entries(event.changes).map(([hash, delta]) => (
                    <span key={hash}><code>{hash}</code><strong>{delta > 0 ? `+${delta}` : delta}</strong></span>
                  ))}
                </div>,
              ])}
            />
            {events.nextAfter < events.latestRevision ? (
              <Button icon={<ChevronsDown size={15} />} onClick={() => void loadEvents(events.nextAfter, true)} disabled={eventsLoading}>
                {eventsLoading ? "Loading…" : "Load more events"}
              </Button>
            ) : null}
          </>
        ) : null}
      </Card>
    </>
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
