import { useCallback, useEffect, useState } from "react";
import type { CasRefDomain } from "@unidocs/protocol-cas-admin";
import { api, ifMatch } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

export function RefDomainsView({ stackId }: { stackId: string }) {
  const [domains, setDomains] = useState<CasRefDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ domains: CasRefDomain[] }>(`/admin/stacks/${encodeURIComponent(stackId)}/ref-domains`);
      setDomains(result.domains);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createDomain() {
    setCreating(true);
    setError(null);
    try {
      await api<CasRefDomain>(`/admin/stacks/${encodeURIComponent(stackId)}/ref-domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refDomain: name.trim() }),
      });
      setName("");
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setCreating(false);
    }
  }

  async function transition(domain: CasRefDomain, status: "write_disabled" | "retired") {
    setTransitioning(domain.refDomain);
    setError(null);
    try {
      await api<CasRefDomain>(
        `/admin/stacks/${encodeURIComponent(stackId)}/ref-domains/${encodeURIComponent(domain.refDomain)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...ifMatch(domain.revision) },
          body: JSON.stringify({ status }),
        },
      );
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setTransitioning(null);
    }
  }

  return (
    <>
      <Card title="Register a reference domain">
        <div className="inline-form">
          <input
            aria-label="refDomain"
            value={name}
            placeholder="e.g. doc or doc:markdown"
            onChange={(event) => setName(event.target.value)}
          />
          <Button variant="primary" onClick={() => void createDomain()} disabled={creating || name.trim().length === 0}>
            {creating ? "Creating…" : "Register"}
          </Button>
        </div>
        <p className="hint">
          Domains are stable business boundaries that emit Root Ref deltas.
          Retiring a domain preserves its historical audit data but stops future writes.
        </p>
      </Card>
      <Card title="Registered domains">
        {error ? <ErrorState message={error} /> : null}
        {domains === null && !error ? <LoadingState /> : null}
        {domains !== null && domains.length === 0 ? (
          <EmptyState message="No domains registered." />
        ) : null}
        {domains !== null && domains.length > 0 ? (
          <Table
            columns={["Domain", "Status", "Revision", ""]}
            empty="No domains."
            rows={domains.map((domain) => [
              domain.refDomain,
              domain.status,
              String(domain.revision),
              <span key={`actions-${domain.refDomain}`}>
                {domain.status === "active" ? (
                  <>
                    <Button
                      variant="plain"
                      disabled={transitioning === domain.refDomain}
                      onClick={() => void transition(domain, "write_disabled")}
                    >
                      Disable writes
                    </Button>{" "}
                    <Button
                      variant="danger"
                      disabled={transitioning === domain.refDomain}
                      onClick={() => void transition(domain, "retired")}
                    >
                      Retire
                    </Button>
                  </>
                ) : domain.status === "write_disabled" ? (
                  <Button
                    variant="danger"
                    disabled={transitioning === domain.refDomain}
                    onClick={() => void transition(domain, "retired")}
                  >
                    Retire
                  </Button>
                ) : "—"}
              </span>,
            ])}
          />
        ) : null}
      </Card>
    </>
  );
}
