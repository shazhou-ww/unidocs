import { useCallback, useEffect, useState } from "react";
import { ChevronsDown } from "lucide-react";
import type { CasControlAuditEvent } from "@unicas/admin-client";
import { api } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

interface AuditPage {
  readonly items: readonly CasControlAuditEvent[];
  readonly nextCursor: string | null;
}

function isLegacyIssuerAction(action: string): boolean {
  return action.startsWith("issuer.");
}

export function ControlAuditView({ stackId }: { stackId: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (nextCursor: string | null, replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const query = nextCursor ? `?limit=50&cursor=${encodeURIComponent(nextCursor)}` : "?limit=50";
      const result = await api<AuditPage>(`/admin/stacks/${encodeURIComponent(stackId)}/audit-events${query}`);
      setPage((previous) => {
        if (!replace && previous) {
          return { items: [...previous.items, ...result.items], nextCursor: result.nextCursor };
        }
        return result;
      });
      setCursor(result.nextCursor);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setLoading(false);
    }
  }, [stackId]);

  useEffect(() => {
    void load(null, true);
  }, [load]);

  return (
    <Card title="Change Log">
      <p className="hint">Append-only record of every administrative change to this stack.</p>
      {error ? <ErrorState message={error} /> : null}
      {page === null && !error ? <LoadingState /> : null}
      {page !== null && page.items.length === 0 ? (
        <EmptyState message="No control audit events yet." />
      ) : null}
      {page !== null && page.items.length > 0 ? (
        <>
          <Table
            columns={["Time", "Action", "Actor", "Target", "Request ID"]}
            empty="No events."
            rows={page.items.map((event) => [
              new Date(event.createdAt).toLocaleString(),
              <span className="action-label" key={`action-${event.eventId}`}>
                <code>{event.action}</code>
                {isLegacyIssuerAction(event.action) ? (
                  <span className="legacy-badge" title="Historical action from the retired issuer-key API">Legacy</span>
                ) : null}
              </span>,
              event.actor.subject,
              <code key={`target-${event.eventId}`}>{event.target}</code>,
              event.requestId ?? "—",
            ])}
          />
          {cursor ? (
            <Button icon={<ChevronsDown size={15} />} onClick={() => void load(cursor, false)} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
