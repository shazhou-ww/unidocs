import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  createDocument,
  downloadDocument,
  listDocuments,
  type GatewayDocumentRecord,
} from "./api.js";
import { DEFAULT_DOC_TYPES, DEFAULT_TENANT, REDIRECT_PATH } from "./config.js";
import {
  clearSession,
  completeLogin,
  loadSession,
  startLogin,
  type OAuthTokenSession,
} from "./oauth.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const [session, setSession] = useState<OAuthTokenSession | null>(() => loadSession());
  const [tenant, setTenant] = useState<string>(() => loadSession()?.tenantId ?? DEFAULT_TENANT);
  const [documents, setDocuments] = useState<Record<string, GatewayDocumentRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // OAuth callback: exchange the code for a token, then return to the list.
  useEffect(() => {
    if (window.location.pathname !== REDIRECT_PATH) return;
    completeLogin(new URL(window.location.href))
      .then((next) => {
        setSession(next);
        if (next.tenantId) setTenant(next.tenantId);
        window.history.replaceState(null, "", "/ui/");
      })
      .catch((err) => {
        setError(`Sign-in failed: ${errorMessage(err)}`);
        window.history.replaceState(null, "", "/ui/");
      });
  }, []);

  const reload = useCallback(async () => {
    if (!session || !tenant.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const groups = await Promise.all(
        DEFAULT_DOC_TYPES.map(async (docType) => [
          docType,
          await listDocuments(tenant.trim(), docType),
        ] as const),
      );
      setDocuments(Object.fromEntries(groups));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession(null);
      }
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [session, tenant]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async (docType: string) => {
    if (!session || !tenant.trim()) return;
    setCreating(docType);
    setError(null);
    setNotice(null);
    try {
      const created = await createDocument(tenant.trim(), docType);
      setNotice(`Created ${docType} document ${created.docId} (version ${created.version})`);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(null);
    }
  }, [session, tenant, reload]);

  const exportDocument = useCallback(async (doc: GatewayDocumentRecord) => {
    setError(null);
    setNotice(null);
    try {
      await downloadDocument(tenant.trim(), doc.doc_type, doc.doc_id, `document-${doc.doc_id}.${doc.doc_type}`);
      setNotice(`Downloaded ${doc.doc_id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [tenant]);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setDocuments({});
    setNotice("Signed out");
  }, []);

  const totalCount = useMemo(
    () => Object.values(documents).reduce((sum, list) => sum + list.length, 0),
    [documents],
  );

  if (!session) {
    return (
      <main className="shell">
        <h1>UniDocs</h1>
        <p className="muted">Sign in with your Google account to browse your documents.</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tenant.trim()) {
              setError("A tenant ID is required");
              return;
            }
            setError(null);
            void startLogin({ tenantId: tenant.trim() }).catch((err) => setError(errorMessage(err)));
          }}
        >
          <label htmlFor="tenant">Tenant ID</label>
          <input
            id="tenant"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
            placeholder="e.g. alice"
            autoComplete="off"
          />
          <button type="submit">Sign in</button>
        </form>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <h1>UniDocs</h1>
        <div className="topbar-right">
          <span className="muted">tenant: {tenant || "—"}</span>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {loading ? <p className="muted">Loading documents…</p> : null}
      {!loading && totalCount === 0 ? <p className="muted">No documents yet.</p> : null}
      {DEFAULT_DOC_TYPES.map((docType) => {
        const list = documents[docType] ?? [];
        return (
          <section key={docType} className="doc-group">
            <header className="doc-group-header">
              <h2>{docType}</h2>
              <button
                type="button"
                disabled={creating === docType}
                onClick={() => void create(docType)}
              >
                {creating === docType ? "Creating…" : "New document"}
              </button>
            </header>
            {list.length === 0 ? (
              <p className="muted">No {docType} documents.</p>
            ) : (
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>doc_id</th>
                    <th>version</th>
                    <th>created</th>
                    <th>updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((doc) => (
                    <tr key={doc.doc_id}>
                      <td><code>{doc.doc_id}</code></td>
                      <td>{doc.version}</td>
                      <td>{new Date(doc.created_at).toLocaleString()}</td>
                      <td>{new Date(doc.updated_at).toLocaleString()}</td>
                      <td>
                        <button type="button" onClick={() => void exportDocument(doc)}>
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </main>
  );
}
