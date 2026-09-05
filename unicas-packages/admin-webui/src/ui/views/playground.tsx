import { useEffect, useState } from "react";
import { Activity, Database, Download, KeyRound, Minus, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { CasManagedCapability, CasStackOAuthIssuer } from "@unicas/admin-client";
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import type { CasGcResult, CasNodeMetadata, CasRootRefsPage, CasUsage } from "@unicas/tenant-client";
import { api } from "../api.js";
import { Button, Card, EmptyState, ErrorState, LoadingState, Table, Tabs } from "../components.js";
import { formatErrorSafe } from "./view-helpers.js";

type PlaygroundTab = "roots" | "upload" | "usage" | "gc";

const PLAYGROUND_TABS = [
  { id: "roots", label: "Roots", icon: <Database size={15} /> },
  { id: "upload", label: "Upload", icon: <Upload size={15} /> },
  { id: "usage", label: "Usage", icon: <Activity size={15} /> },
  { id: "gc", label: "Garbage collection", icon: <Trash2 size={15} /> },
];

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function requestId(): string {
  return crypto.randomUUID();
}

export function PlaygroundView({ stackId }: { stackId: string }) {
  const [issuer, setIssuer] = useState<CasStackOAuthIssuer | null>(null);
  const [capability, setCapability] = useState<CasManagedCapability | null>(null);
  const [tab, setTab] = useState<PlaygroundTab>("roots");
  const [clock, setClock] = useState(Date.now());
  const [roots, setRoots] = useState<CasRootRefsPage | null>(null);
  const [rootMetadata, setRootMetadata] = useState<CasNodeMetadata | null>(null);
  const [usage, setUsage] = useState<CasUsage | null>(null);
  const [gcResult, setGcResult] = useState<CasGcResult | null>(null);
  const [gcMaxNodes, setGcMaxNodes] = useState("100");
  const [gcConfirmed, setGcConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [retainUpload, setRetainUpload] = useState(true);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedHash, setUploadedHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCapability(null);
    setRoots(null);
    setRootMetadata(null);
    setUsage(null);
    setGcResult(null);
    setUploadedHash(null);
    setError(null);
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

  useEffect(() => {
    if (!capability) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [capability]);

  const expired = capability !== null && clock >= capability.expiresAt;
  const secondsRemaining = capability ? Math.max(0, Math.ceil((capability.expiresAt - clock) / 1_000)) : 0;

  function clients(current: CasManagedCapability) {
    const tenant = createTenantCasClient({
      baseUrl: new URL(current.audience).origin,
      stackId,
      tenantId: current.tenantId,
      getToken: async () => current.accessToken,
      uploadMode: "legacy",
    });
    return { tenant, blobs: createCasBlobClient(tenant) };
  }

  async function mint() {
    setMinting(true);
    setError(null);
    setUsage(null);
    try {
      const next = await api<CasManagedCapability>(
        `/admin/stacks/${encodeURIComponent(stackId)}/managed-capabilities`,
        { method: "POST" },
      );
      setCapability(next);
      setClock(Date.now());
      setRoots(null);
      setRootMetadata(null);
      setUsage(null);
      setGcResult(null);
      setUploadedHash(null);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setMinting(false);
    }
  }

  async function loadRoots(append = false) {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      const page = await clients(capability).tenant.listRootRefs({
        limit: 50,
        cursor: append ? roots?.nextCursor ?? undefined : undefined,
      });
      setRoots(append && roots ? { ...page, items: [...roots.items, ...page.items] } : page);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function mutateRoot(hash: string, action: "retain" | "release") {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      await clients(capability).blobs[action]({ requestId: requestId(), references: { [hash]: 1 } });
      const page = await clients(capability).tenant.listRootRefs({ limit: 50 });
      setRoots(page);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function inspectRoot(hash: string) {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      setRootMetadata(await clients(capability).tenant.readMetadata(hash));
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function downloadRoot(hash: string) {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      const handle = await clients(capability).blobs.openBlob(hash);
      const blob = await new Response(handle.read()).blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = hash;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function uploadFile() {
    if (!capability || !file) return;
    setRunning(true);
    setError(null);
    setUploadProgress(0);
    setUploadedHash(null);
    try {
      const { blobs } = clients(capability);
      const blob = await blobs.storeBlob(file, {
        contentType: file.type || "application/octet-stream",
        size: file.size,
        onProgress: setUploadProgress,
      });
      if (retainUpload) {
        await blobs.retain({ requestId: requestId(), references: { [blob.hash]: 1 } });
      }
      setUploadedHash(blob.hash);
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function readUsage() {
    if (!capability) return;
    setRunning(true);
    setError(null);
    try {
      setUsage(await clients(capability).tenant.usage());
    } catch (caught) {
      setError(formatErrorSafe(caught));
    } finally {
      setRunning(false);
    }
  }

  async function collectGarbage() {
    if (!capability || !gcConfirmed) return;
    setRunning(true);
    setError(null);
    try {
      setGcResult(await clients(capability).tenant.gc({ maxNodes: Number(gcMaxNodes) }));
      setGcConfirmed(false);
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
              {minting ? "Issuing…" : capability ? "Renew capability" : "Issue capability"}
            </Button>
          </>
        ) : (
          <p className="muted">Enable the managed issuer to issue playground capabilities.</p>
        )}
        {error ? <ErrorState message={error} /> : null}
      </Card>
      {capability ? (
        <>
          <Card title="Personal sandbox">
            <dl className="detail-list playground-credential">
              <div><dt>Tenant</dt><dd><code>{capability.tenantId}</code></dd></div>
              <div><dt>Credential</dt><dd className={expired ? "playground-expired" : ""}>{expired ? "Expired" : `${secondsRemaining}s remaining`}</dd></div>
              <div><dt>Permissions</dt><dd>{capability.permissions.join(", ")}</dd></div>
            </dl>
            {expired ? <ErrorState message="The playground capability has expired. Renew it to continue." /> : null}
          </Card>
          <Tabs tabs={PLAYGROUND_TABS} active={tab} onChange={(id) => setTab(id as PlaygroundTab)} />
          {tab === "roots" ? (
            <Card title="Retained roots">
              <div className="playground-actions">
                <Button icon={<RefreshCw size={15} />} onClick={() => void loadRoots()} disabled={running || expired}>Refresh roots</Button>
              </div>
              {roots ? (
                <>
                  <p className="muted">Reference domain <code>{roots.refDomain}</code>, revision {roots.revision}</p>
                  <Table
                    columns={["Hash", "References", "Actions"]}
                    empty="No retained roots."
                    rows={roots.items.map((root) => [
                      <button className="playground-hash" type="button" onClick={() => void inspectRoot(root.hash)} disabled={running || expired}>{root.hash}</button>,
                      root.refCount,
                      <span className="playground-row-actions">
                        <Button icon={<Plus size={14} />} variant="plain" onClick={() => void mutateRoot(root.hash, "retain")} disabled={running || expired}>Retain</Button>
                        <Button icon={<Minus size={14} />} variant="plain" onClick={() => void mutateRoot(root.hash, "release")} disabled={running || expired}>Release</Button>
                        <Button icon={<Download size={14} />} variant="plain" onClick={() => void downloadRoot(root.hash)} disabled={running || expired}>Download</Button>
                      </span>,
                    ])}
                  />
                  {roots.nextCursor ? <Button onClick={() => void loadRoots(true)} disabled={running || expired}>Load more</Button> : null}
                </>
              ) : <EmptyState message="Refresh to read roots in your managed reference domain." />}
              {rootMetadata ? <pre className="code-block">{JSON.stringify(rootMetadata, null, 2)}</pre> : null}
            </Card>
          ) : null}
          {tab === "upload" ? (
            <Card title="Upload a file">
              <div className="field-row">
                <label htmlFor="playground-file">File</label>
                <input id="playground-file" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </div>
              <label className="playground-check"><input type="checkbox" checked={retainUpload} onChange={(event) => setRetainUpload(event.target.checked)} /> Retain the uploaded blob root</label>
              <Button icon={<Upload size={15} />} variant="primary" onClick={() => void uploadFile()} disabled={!file || running || expired}>Upload file</Button>
              {file && running ? <p className="muted">Uploaded {formatBytes(uploadProgress)} of {formatBytes(file.size)}</p> : null}
              {uploadedHash ? <p className="playground-result">Stored as <code>{uploadedHash}</code>{retainUpload ? " and retained." : "."}</p> : null}
            </Card>
          ) : null}
          {tab === "usage" ? (
            <Card title="Tenant usage">
              <Button icon={<RefreshCw size={15} />} onClick={() => void readUsage()} disabled={running || expired}>Refresh usage</Button>
              {usage ? (
                <dl className="playground-metrics">
                  <div><dt>Nodes</dt><dd>{usage.nodeCount}</dd></div>
                  <div><dt>Content</dt><dd>{formatBytes(usage.readyContentBytes)}</dd></div>
                  <div><dt>Stored</dt><dd>{formatBytes(usage.readyStoredBytes)}</dd></div>
                  <div><dt>Reserved</dt><dd>{formatBytes(usage.reservedBytes)}</dd></div>
                  <div><dt>Not ready</dt><dd>{usage.notReadyNodeCount}</dd></div>
                  <div><dt>Leased</dt><dd>{usage.leasedNodeCount}</dd></div>
                </dl>
              ) : null}
            </Card>
          ) : null}
          {tab === "gc" ? (
            <Card title="Garbage collection">
              <div className="field-row">
                <label htmlFor="playground-gc-limit">Maximum nodes to examine</label>
                <input id="playground-gc-limit" type="number" min="1" step="1" value={gcMaxNodes} onChange={(event) => setGcMaxNodes(event.target.value)} />
              </div>
              <label className="playground-check"><input type="checkbox" checked={gcConfirmed} onChange={(event) => setGcConfirmed(event.target.checked)} /> I understand that unreferenced, expired nodes may be deleted</label>
              <Button icon={<Trash2 size={15} />} variant="danger" onClick={() => void collectGarbage()} disabled={!gcConfirmed || !Number.isSafeInteger(Number(gcMaxNodes)) || Number(gcMaxNodes) < 1 || running || expired}>Run garbage collection</Button>
              {gcResult ? <p className="playground-result">Examined {gcResult.examined}, deleted {gcResult.deleted}, reclaimed {formatBytes(gcResult.reclaimedContentBytes)}.</p> : null}
            </Card>
          ) : null}
          {error ? <ErrorState message={error} /> : null}
        </>
      ) : null}
    </>
  );
}