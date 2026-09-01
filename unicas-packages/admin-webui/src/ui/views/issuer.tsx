import { useCallback, useEffect, useState } from "react";
import { Archive, KeyRound, Plus, Save, Search, ShieldCheck } from "lucide-react";
import type {
  CasOAuthIssuerInspection,
  CasStackIssuer,
  CasStackIssuerKey,
  CasStackOAuthIssuer,
} from "@unicas/admin-client";
import { api, ApiError, ifMatch } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, Table } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

export function IssuerView({ stackId }: { stackId: string }) {
  const [oauthIssuer, setOAuthIssuer] = useState<CasStackOAuthIssuer | null>(null);
  const [inspection, setInspection] = useState<CasOAuthIssuerInspection | null>(null);
  const [oauthIssuerUrl, setOAuthIssuerUrl] = useState("");
  const [oauthAudience, setOAuthAudience] = useState("");
  const [activationProof, setActivationProof] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [issuer, setIssuer] = useState<CasStackIssuer | null | "missing">(null);
  const [keys, setKeys] = useState<CasStackIssuerKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuerIssuer, setIssuerIssuer] = useState("");
  const [issuerAudience, setIssuerAudience] = useState("");
  const [maxLifetime, setMaxLifetime] = useState("");
  const [savingIssuer, setSavingIssuer] = useState(false);
  const [kid, setKid] = useState("");
  const [algorithm, setAlgorithm] = useState("ES256");
  const [publicJwk, setPublicJwk] = useState("");
  const [possessionProof, setPossessionProof] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  const [changingKey, setChangingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const oauthResult = await api<CasStackOAuthIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/oauth-issuer`)
        .catch((caught) => {
          if (caught instanceof ApiError && caught.status === 404) return null;
          throw caught;
        });
      setOAuthIssuer(oauthResult);
      if (oauthResult) {
        setOAuthIssuerUrl(oauthResult.issuer);
        setOAuthAudience(oauthResult.audience);
      }
      const issuerResult = await api<CasStackIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/issuer`)
        .catch((caught) => {
          if (caught instanceof Error && caught.message === "issuer is not configured") return null;
          throw caught;
        });
      setIssuer(issuerResult);
      if (issuerResult) {
        setIssuerIssuer(issuerResult.issuer);
        setIssuerAudience(issuerResult.audience);
        setMaxLifetime(issuerResult.capabilityMaxLifetimeSeconds
          ? String(issuerResult.capabilityMaxLifetimeSeconds)
          : "");
      }
      const keyResult = await api<{ keys: CasStackIssuerKey[] }>(`/admin/stacks/${encodeURIComponent(stackId)}/issuer/keys`);
      setKeys(keyResult.keys);
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
      const body: { issuer: string; audience: string; capabilityMaxLifetimeSeconds?: number } = {
        issuer: oauthIssuerUrl.trim(),
        audience: oauthAudience.trim(),
      };
      if (maxLifetime.trim().length > 0) body.capabilityMaxLifetimeSeconds = Number(maxLifetime);
      const result = await api<CasOAuthIssuerInspection>(`/admin/stacks/${encodeURIComponent(stackId)}/oauth-issuer/inspections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setInspection(result);
      setOAuthIssuer({ ...result, status: "pending", verifiedAt: null, lastRefreshAt: Date.now(), lastRefreshError: null });
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

  async function saveIssuer() {
    setSavingIssuer(true);
    setError(null);
    try {
      const body: {
        issuer: string;
        audience: string;
        capabilityMaxLifetimeSeconds?: number;
      } = { issuer: issuerIssuer.trim(), audience: issuerAudience.trim() };
      if (maxLifetime.trim().length > 0) body.capabilityMaxLifetimeSeconds = Number(maxLifetime);
      const currentIssuer = typeof issuer === "object" && issuer !== null ? issuer : null;
      await api<CasStackIssuer>(`/admin/stacks/${encodeURIComponent(stackId)}/issuer`, {
        method: "PUT",
        headers: currentIssuer
          ? { "Content-Type": "application/json", ...ifMatch(currentIssuer.revision) }
          : { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setSavingIssuer(false);
    }
  }

  async function fetchChallenge() {
    setError(null);
    setChallenge(null);
    try {
      // Browser code cannot runtime-import @unicas/admin-client (UI
      // boundary test), so the path stays a literal here — same as the other
      // /admin API calls in this view.
      const result = await api<{ nonce: string }>("/admin/issuer/possession-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stackId, kid: kid.trim(), algorithm }),
      });
      setChallenge([
        "cas-possession-v1",
        result.nonce,
        stackId,
        kid.trim(),
        algorithm,
      ].join("\n"));
    } catch (caught) {
      setError(formatErrorSafe(caught));
    }
  }

  async function addKey() {
    setAddingKey(true);
    setError(null);
    try {
      await api<CasStackIssuerKey>(`/admin/stacks/${encodeURIComponent(stackId)}/issuer/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kid: kid.trim(),
          algorithm,
          publicJwk: JSON.parse(publicJwk) as Record<string, unknown>,
          possessionProof: possessionProof.trim(),
        }),
      });
      setKid("");
      setPublicJwk("");
      setPossessionProof("");
      setChallenge(null);
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setAddingKey(false);
    }
  }

  async function changeKeyState(key: CasStackIssuerKey, toState: "retiring" | "revoked") {
    setChangingKey(key.kid);
    setError(null);
    try {
      await api<CasStackIssuerKey>(
        `/admin/stacks/${encodeURIComponent(stackId)}/issuer/keys/${encodeURIComponent(key.kid)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...ifMatch(key.revision) },
          body: JSON.stringify({ toState }),
        },
      );
      await load();
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setChangingKey(null);
    }
  }

  return (
    <>
      <Card title="OAuth authorization server">
        {error ? <ErrorState message={error} /> : null}
        <p className="hint">
          Connect a standards-based authorization server through RFC 8414 or OpenID discovery.
          UniCAS validates its metadata and JWKS, then requires a signed control challenge before activation.
        </p>
        {oauthIssuer ? (
          <p className="hint">Status: <strong>{oauthIssuer.status}</strong> · Metadata: {oauthIssuer.metadataType} · Revision {oauthIssuer.revision}</p>
        ) : null}
        <div className="field-row">
          <label htmlFor="oauth-issuer-url">Issuer</label>
          <input id="oauth-issuer-url" value={oauthIssuerUrl} placeholder="https://authorization.example" onChange={(event) => setOAuthIssuerUrl(event.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="oauth-issuer-audience">Audience</label>
          <input id="oauth-issuer-audience" value={oauthAudience} placeholder="unicas-cas" onChange={(event) => setOAuthAudience(event.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="issuer-max-lifetime">Max capability lifetime (s)</label>
          <input id="issuer-max-lifetime" value={maxLifetime} placeholder="28800 (default 8h; max 604800)" onChange={(event) => setMaxLifetime(event.target.value)} />
        </div>
        <Button icon={<Search size={15} />} variant="primary" onClick={() => void inspectOAuthIssuer()} disabled={inspecting || oauthIssuer?.status === "active" || oauthIssuerUrl.trim().length === 0 || oauthAudience.trim().length === 0}>
          {inspecting ? "Inspecting…" : "Inspect issuer"}
        </Button>
        {inspection ? (
          <div className="challenge-box">
            <p>Discovered {inspection.keys.length} signing key(s). Sign exactly this challenge with one discovered private key:</p>
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
      <Card title="Legacy tenant issuer (deprecated)">
        <p className="hint">Manual issuer and key management remains available for migration only. New stacks should use OAuth discovery above.</p>
        <div className="field-row">
          <label htmlFor="issuer-url">Issuer</label>
          <input id="issuer-url" value={issuerIssuer} placeholder="https://tenant-issuer.example" onChange={(event) => setIssuerIssuer(event.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="issuer-audience">Audience</label>
          <input id="issuer-audience" value={issuerAudience} placeholder="unidocs-cas" onChange={(event) => setIssuerAudience(event.target.value)} />
        </div>
        <Button icon={<Save size={15} />} variant="primary" onClick={() => void saveIssuer()} disabled={savingIssuer || issuerIssuer.trim().length === 0 || issuerAudience.trim().length === 0}>
          {savingIssuer ? "Saving…" : issuer ? "Update issuer" : "Configure issuer"}
        </Button>
      </Card>
      <Card title="Legacy issuer keys (deprecated)">
        {keys === null ? <LoadingState /> : null}
        {keys !== null && keys.length === 0 ? (
          <EmptyState message="No keys yet. Create one below; possession of the private key is proven with a signed challenge." />
        ) : null}
        {keys !== null && keys.length > 0 ? (
          <Table
            columns={["kid", "Algorithm", "State", "Revision", ""]}
            empty="No keys."
            rows={keys.map((key) => [
              key.kid,
              key.algorithm,
              key.state,
              String(key.revision),
              <span key={`actions-${key.kid}`}>
                {key.state === "active" || key.state === "retiring" ? (
                  <Button
                    icon={<Archive size={15} />}
                    variant="danger"
                    disabled={changingKey === key.kid}
                    onClick={() => void changeKeyState(key, key.state === "active" ? "retiring" : "revoked")}
                  >
                    {key.state === "active" ? "Retire" : "Revoke"}
                  </Button>
                ) : "—"}
              </span>,
            ])}
          />
        ) : null}
      </Card>
      <Card title="Add a legacy issuer key (deprecated)">
        <p className="hint">
          Generate a key pair and sign the challenge with the private key outside
          the browser (see <code>scripts/cas-possession-sign.mjs</code>), then paste
          the public JWK and the compact JWS proof below.
        </p>
        <div className="field-row">
          <label htmlFor="key-kid">kid</label>
          <input id="key-kid" value={kid} placeholder="key-2026" onChange={(event) => setKid(event.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="key-alg">Algorithm</label>
          <select id="key-alg" value={algorithm} onChange={(event) => setAlgorithm(event.target.value)}>
            <option value="ES256">ES256</option>
            <option value="RS256">RS256</option>
            <option value="EdDSA">EdDSA</option>
          </select>
        </div>
        <Button icon={<KeyRound size={15} />} onClick={() => void fetchChallenge()} disabled={kid.trim().length === 0}>
          Request possession challenge
        </Button>
        {challenge ? (
          <div className="challenge-box">
            <p>Sign exactly this challenge string with your private key:</p>
            <code className="challenge">{challenge}</code>
          </div>
        ) : null}
        <div className="field-row">
          <label htmlFor="key-jwk">Public JWK</label>
          <textarea id="key-jwk" value={publicJwk} rows={4} placeholder='{"kty":"EC","crv":"P-256",…}' onChange={(event) => setPublicJwk(event.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="key-proof">Possession proof (compact JWS)</label>
          <textarea id="key-proof" value={possessionProof} rows={3} onChange={(event) => setPossessionProof(event.target.value)} />
        </div>
        <Button
          icon={<Plus size={15} />}
          variant="primary"
          disabled={addingKey || kid.trim().length === 0 || publicJwk.trim().length === 0 || possessionProof.trim().length === 0}
          onClick={() => void addKey()}
        >
          {addingKey ? "Adding…" : "Add key"}
        </Button>
      </Card>
    </>
  );
}
