import { useState } from "react";
import type { CasStack } from "@unicas/protocol-admin";
import { api, ifMatch } from "../api.js";
import { Button, Card, ErrorState } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

export function StackOverviewView({ stack, onChanged }: {
  stack: CasStack;
  onChanged: () => void;
}) {
  const [name, setName] = useState(stack.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      await api<CasStack>(`/admin/stacks/${encodeURIComponent(stack.stackId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...ifMatch(stack.revision) },
        body: JSON.stringify({ displayName: name.trim() }),
      });
      onChanged();
    } catch (caught) {
      const message = formatErrorSafe(caught);
      setError(message);
      if (message.includes("revision") || message.includes("changed")) setConflict(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Stack metadata">
      <div className="field-row">
        <label htmlFor="stack-display-name">Display name</label>
        <input
          id="stack-display-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button variant="primary" onClick={() => void save()} disabled={saving || name.trim().length === 0 || name === stack.displayName}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {conflict ? (
        <p className="hint">
          The stack changed on the server (revision {stack.revision}). Reload the page and retry.
        </p>
      ) : null}
    </Card>
  );
}
