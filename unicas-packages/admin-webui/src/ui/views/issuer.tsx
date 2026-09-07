import { useCallback, useEffect, useState } from "react";
import { Power, Search, ShieldCheck } from "lucide-react";
import type {
  CasOAuthIssuerInspection,
  CasStackOAuthIssuer,
} from "@unicas/admin-client";
import { api, ifMatch } from "../api.js";
import { Button, Card, ErrorState } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

/**
 * Stack OAuth issuer connection. UniCAS discovers the issuer's metadata and
 * JWKS itself (RFC 8414 / OpenID discovery), so administrators never upload
 * keys: activation proves control of a key the issuer currently advertises,
 * and tenant verification reads the issuer's discovered jwks_uri.
 */
export function IssuerView({ stackId }: { stackId: string }) {
  const [oauthIssuer, setOAuthIssuer] = useState<CasStackOAuthIssuer | null>(null);
  const [managedIssuer, setManagedIssuer] = useState<CasStackOAuthIssuer | null>(null);
  const [inspection, setInspection] = useState<CasOAuthIssuerInspection | null>(null);
  const [oauthIssuerUrl, setOAuthIssuerUrl] = useState("");
  const [activationProof, setActivationProof] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [togglingManaged, setTogglingManaged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [oauthResult, managedResult] = await Promise.all([
        api<CasStackOAuthIssuer | null>(`/admin/stacks/${encodeURIComponent(stackId)}/oauth-issuer?optional=true`),
        api<CasStackOAuthIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/managed-issuer`),
      ]);
      setOAuthIssuer(oauthResult);
      setManagedIssuer(managedResult);
      if (oauthResult) {
        setOAuthIssuerUrl(oauthResult.issuer);
      }
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function inspectOAuthIssuer() {
    setInspecting(true);
    setError(null);
    try {
      const result = await api<CasOAuthIssuerInspection>(`/admin/stacks/${encodeURIComponent(stackId)}/oauth-issuer/inspections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issuer: oauthIssuerUrl.trim() }),
      });
      setInspection(result);
      setOAuthIssuer({ ...result, mode: "external", status: "pending", verifiedAt: null, lastRefreshAt: Date.now(), lastRefreshError: null });
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setInspecting(false);
    }
  }

  async function activateOAuthIssuer() {
    if (!inspection || !oauthIssuer) return;
    setActivating(true);
    setError(null);
    try {
      await api<CasStackOAuthIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/oauth-issuer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...ifMatch(oauthIssuer.revision) },
        body: JSON.stringify({ inspectionId: inspection.inspectionId, activationProof: activationProof.trim() }),
      });
      setInspection(null);
      setActivationProof("");
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setActivating(false);
    }
  }

  async function toggleManagedIssuer() {
    if (!managedIssuer) return;
    setTogglingManaged(true);
    setError(null);
    try {
      const enabled = managedIssuer.status !== "active";
      setManagedIssuer(await api<CasStackOAuthIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/managed-issuer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...ifMatch(managedIssuer.revision) },
        body: JSON.stringify({ enabled }),
      }));
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setTogglingManaged(false);
    }
  }

  const configured = oauthIssuer !== null;
  const canInspect = oauthIssuer === null || oauthIssuer.status !== "active";

  return (
    <>
      <Card title="Managed issuer">
        {error ? <ErrorState message={error} /> : null}
        {managedIssuer ? (
          <>
            <p className="hint">
              Status: <strong>{managedIssuer.status}</strong> · Revision {managedIssuer.revision}
              <br />Issuer: <code>{managedIssuer.issuer}</code>
            </p>
            <div className="field-row">
              <label htmlFor="managed-issuer-url">Managed issuer URL</label>
              <input id="managed-issuer-url" value={managedIssuer.issuer} readOnly />
            </div>
            <Button icon={<Power size={15} />} variant="primary" onClick={() => void toggleManagedIssuer()} disabled={togglingManaged}>
              {togglingManaged ? "Updating…" : managedIssuer.status === "active" ? "Disable managed issuer" : "Enable managed issuer"}
            </Button>
          </>
        ) : null}
      </Card>
      <Card title="Custom OAuth authorization server">
      <p className="hint">
        Connect a standards-based authorization server through RFC 8414 or OpenID discovery.
        UniCAS validates its metadata and JWKS, then requires a signed control challenge before
        activation. When active, this issuer is listed before the managed issuer and is the CLI login default.
      </p>
      {configured ? (
        <p className="hint">
          Mode: <strong>{oauthIssuer!.mode}</strong> · Status: <strong>{oauthIssuer!.status}</strong> · Metadata: {oauthIssuer!.metadataType} · Revision {oauthIssuer!.revision}
          <br />Issuer: {oauthIssuer!.issuer}
          <br />JWKS: <a href={oauthIssuer!.jwksUri} target="_blank" rel="noreferrer">{oauthIssuer!.jwksUri}</a>
          <br />Resource audience: {oauthIssuer!.audience} · Maximum capability lifetime: {oauthIssuer!.capabilityMaxLifetimeSeconds}s
        </p>
      ) : null}
      <div className="field-row">
        <label htmlFor="oauth-issuer-url">Issuer</label>
        <input id="oauth-issuer-url" value={oauthIssuerUrl} placeholder="https://authorization.example" disabled={!canInspect} onChange={(event) => setOAuthIssuerUrl(event.target.value)} />
      </div>
      <Button icon={<Search size={15} />} variant="primary" onClick={() => void inspectOAuthIssuer()} disabled={inspecting || !canInspect || oauthIssuerUrl.trim().length === 0}>
        {inspecting ? "Inspecting…" : oauthIssuer?.status === "active" ? "Issuer active" : "Inspect issuer"}
      </Button>
      {inspection ? (
        <div className="challenge-box">
          <p>
            The issuer JWKS contains {inspection.keys.length} eligible signing key(s).
            Sign this one-time control challenge with the matching private key:
          </p>
          <code className="challenge">{inspection.challenge}</code>
          <div className="field-row">
            <label htmlFor="oauth-activation-proof">Activation proof (compact JWS)</label>
            <textarea id="oauth-activation-proof" value={activationProof} rows={3} onChange={(event) => setActivationProof(event.target.value)} />
          </div>
          <Button icon={<ShieldCheck size={15} />} variant="primary" disabled={activating || activationProof.trim().length === 0} onClick={() => void activateOAuthIssuer()}>
            {activating ? "Activating…" : "Verify and activate"}
          </Button>
        </div>
      ) : null}
      </Card>
    </>
  );
}
