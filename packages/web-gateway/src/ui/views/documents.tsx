import { LoaderCircle, Plus, Download, LogOut, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  createDocument,
  downloadDocument,
  listDocuments,
  type GatewayDocumentRecord,
} from "../api.js";
import { DEFAULT_DOC_TYPES } from "../config.js";
import { clearSession, type OAuthTokenSession } from "../oauth.js";
import { navigate } from "../router.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface DocumentsViewProps {
  readonly session: OAuthTokenSession;
  readonly onSignedOut: () => void;
}

/**
 * The signed-in view: document list per doc type for the account's
 * server-derived tenant, with create and export actions.
 */
export function DocumentsView({ session, onSignedOut }: DocumentsViewProps) {
  const tenantId = session.tenantId;
  const [documents, setDocuments] = useState<Record<string, GatewayDocumentRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const groups = await Promise.all(
        DEFAULT_DOC_TYPES.map(async (docType) => [
          docType,
          await listDocuments(tenantId, docType),
        ] as const),
      );
      setDocuments(Object.fromEntries(groups));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        onSignedOut();
        return;
      }
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async (docType: string) => {
    if (!tenantId) return;
    setCreating(docType);
    setError(null);
    setNotice(null);
    try {
      const created = await createDocument(tenantId, docType);
      setNotice(`Created ${docType} document ${created.docId} (version ${created.version})`);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(null);
    }
  }, [tenantId, reload]);

  const exportDocument = useCallback(async (doc: GatewayDocumentRecord) => {
    setError(null);
    setNotice(null);
    try {
      await downloadDocument(tenantId, doc.doc_type, doc.doc_id, `document-${doc.doc_id}.${doc.doc_type}`);
      setNotice(`Downloaded ${doc.doc_id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [tenantId]);

  const totalCount = useMemo(
    () => Object.values(documents).reduce((sum, list) => sum + list.length, 0),
    [documents],
  );

  return (
    <main className="shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">U</span>
          <span>UniDocs</span>
        </div>
        <div className="app-header-right">
          {tenantId ? <span className="muted">tenant: {tenantId}</span> : null}
          <button type="button" className="btn" onClick={onSignedOut}>
            <LogOut size={15} aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </header>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {loading ? (
        <p className="state loading" role="status">
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
          <span>Loading documents…</span>
        </p>
      ) : null}
      {!loading && totalCount === 0 ? (
        <p className="state empty">No documents yet.</p>
      ) : null}
      {DEFAULT_DOC_TYPES.map((docType) => {
        const list = documents[docType] ?? [];
        return (
          <section key={docType} className="card doc-group">
            <header className="doc-group-header">
              <h2>{docType}</h2>
              <button
                type="button"
                className="btn btn-primary"
                disabled={creating === docType}
                onClick={() => void create(docType)}
              >
                <Plus size={15} aria-hidden="true" />
                {creating === docType ? "Creating…" : "New document"}
              </button>
            </header>
            {list.length === 0 ? (
              <p className="muted">No {docType} documents.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
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
                          {(doc.doc_type === "markdown" || doc.doc_type === "psd") && <button type="button" className="btn" onClick={() => navigate(`/preview/${encodeURIComponent(doc.doc_type)}/${encodeURIComponent(doc.doc_id)}`)}><Eye size={14} /><span>打开预览</span></button>}
                          <button type="button" className="btn" onClick={() => void exportDocument(doc)}>
                            <Download size={14} aria-hidden="true" />
                            <span>Download</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      <div className="muted">
        <button type="button" className="btn" onClick={() => navigate("/")}>
          Back
        </button>
      </div>
    </main>
  );
}
