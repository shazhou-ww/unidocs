import { useCallback, useEffect, useState } from "react";
import type { CasRefDomain } from "@unicas/protocol-admin";
import { api } from "../api.js";
import { Card, EmptyState, ErrorState, LoadingState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

export function RefDomainsView({ stackId }: { stackId: string }) {
  const [domains, setDomains] = useState<CasRefDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ domains: CasRefDomain[] }>(
        `/admin/stacks/${encodeURIComponent(stackId)}/ref-domains`,
      );
      setDomains(result.domains);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card title="Observed ref domains">
      {error ? <ErrorState message={error} /> : null}
      {domains === null && !error ? <LoadingState /> : null}
      {domains !== null && domains.length === 0 ? (
        <EmptyState message="No Root Ref audit domains observed." />
      ) : null}
      {domains !== null && domains.length > 0 ? (
        <Table
          columns={["Domain", "Latest revision"]}
          empty="No Root Ref audit domains observed."
          rows={domains.map((domain) => [domain.refDomain, String(domain.revision)])}
        />
      ) : null}
    </Card>
  );
}