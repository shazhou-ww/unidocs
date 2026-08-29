import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { CasStack } from "@unicas/admin-protocol";
import { api } from "../api.js";
import { formatErrorSafe } from "./view-helpers.js";
import { Button, Card, ConceptGuide, EmptyState, ErrorState, LoadingState, Page } from "../components.js";

export function MyStacksView() {
  const [stacks, setStacks] = useState<CasStack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ items: CasStack[] }>("/admin/stacks");
      setStacks(result.items);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createStack() {
    setCreating(true);
    setCreateError(null);
    try {
      await api<CasStack>("/admin/stacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      setName("");
      await load();
    } catch (caught) {
      setCreateError(formatErrorSafe(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page title="My Stacks">
      <ConceptGuide
        title="CAS stacks"
        summary="A stack is the top-level UniCAS trust and storage boundary for one independently administered application deployment."
        concepts={[
          { term: "Isolation", detail: "Each stack has independent issuer trust, tenants, Root Ref audit history, and stored objects." },
          { term: "Stable identity", detail: "UniCAS generates an opaque stack ID. The display name is only an operator-facing label." },
          { term: "First membership", detail: "Registering a stack makes your current OIDC identity its first administrator." },
        ]}
      />
      <Card title="Register a stack">
        <div className="inline-form">
          <input
            aria-label="Stack display name"
            value={name}
            placeholder="e.g. unidocs-cloudflare"
            onChange={(event) => setName(event.target.value)}
          />
          <Button icon={<Plus size={15} />} variant="primary" onClick={() => void createStack()} disabled={creating || name.trim().length === 0}>
            {creating ? "Creating…" : "Create stack"}
          </Button>
        </div>
        {createError ? <ErrorState message={createError} /> : null}
      </Card>
      <Card title="Your stacks">
        {error ? <ErrorState message={error} /> : null}
        {stacks === null && !error ? <LoadingState /> : null}
        {stacks !== null && stacks.length === 0 ? (
          <EmptyState message="You are not a member of any stack yet. Register one above." />
        ) : null}
        {stacks !== null && stacks.length > 0 ? (
          <ul className="stack-list">
            {stacks.map((stack) => (
              <li key={stack.stackId}>
                <a href={`#/stacks/${encodeURIComponent(stack.stackId)}`}>
                  <strong>{stack.displayName}</strong>
                  <span className="muted">{stack.stackId}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </Page>
  );
}
