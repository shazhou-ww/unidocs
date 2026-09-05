import { useEffect, useState } from "react";
import { KeyRound, Play } from "lucide-react";
import type { CasManagedCapability, CasStackOAuthIssuer } from "@unicas/admin-client";
import { api } from "../api.js";
import { Button, Card, ErrorState, LoadingState } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

export function PlaygroundView({ stackId }: { stackId: string }) {
  const [issuer, setIssuer] = useState<CasStackOAuthIssuer | null>(null);
  const [capability, setCapability] = useState<CasManagedCapability | null>(null);
  const [usage, setUsage] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api<CasStackOAuthIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/managed-issuer`)
      .then((value) => {
        if (active) setIssuer(value);
      })
      .catch((caught) => {
        if (active) setError(formatErrorSafe(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [stackId]);

  async function mint() {
    setMinting(true);
    setError(null);
    setUsage(null);
    try {
      setCapability(await api<CasManagedCapability>(
        `/admin/stacks/${encodeURIComponent(stackId)}/managed-capabilities`,
        { method: "POST" },
      ));
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setMinting(false);
    }
  }

  async function readUsage() {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(
        `${capability.audience}/tenants/${encodeURIComponent(capability.tenantId)}/cas/usage`,
        { headers: { Authorization: `Bearer ${capability.accessToken}` } },
      );
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) throw new Error(`Tenant API returned HTTP ${response.status}`);
      setUsage(body);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  if (loading) return <LoadingState />;
  if (!issuer) return error ? <ErrorState message={error} /> : null;

  return (
    <>
      <Card title="Managed capability">
        {issuer.status === "active" ? (
          <>
            <p className="muted">Issue a 120-second capability for your member-isolated playground tenant.</p>
            <Button icon={<KeyRound size={15} />} variant="primary" onClick={() => void mint()} disabled={minting}>
              {minting ? "Issuing…" : "Issue capability"}
            </Button>
          </>
        ) : (
          <p className="muted">Enable the managed issuer to issue playground capabilities.</p>
        )}
        {error ? <ErrorState message={error} /> : null}
      </Card>
      {capability ? (
        <Card title="Current credential">
          <dl className="detail-list">
            <div><dt>Tenant</dt><dd><code>{capability.tenantId}</code></dd></div>
            <div><dt>Expires</dt><dd>{new Date(capability.expiresAt).toLocaleTimeString()}</dd></div>
            <div><dt>Permissions</dt><dd>{capability.permissions.join(", ")}</dd></div>
          </dl>
          <label htmlFor="playground-token">Bearer token</label>
          <textarea id="playground-token" readOnly rows={5} value={capability.accessToken} />
          <Button icon={<Play size={15} />} onClick={() => void readUsage()} disabled={running || Date.now() >= capability.expiresAt}>
            {running ? "Running…" : "Read tenant usage"}
          </Button>
          {usage !== null ? <pre className="code-block">{JSON.stringify(usage, null, 2)}</pre> : null}
        </Card>
      ) : null}
    </>
  );
}