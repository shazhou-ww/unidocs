import { useEffect, useRef, useState } from "react";
import { Eye, RefreshCw } from "lucide-react";
import { ApiError, documentStatus, type GatewayDocumentStatus } from "../api.js";

export interface CreationStatusProps {
  tenantId: string;
  docType: string;
  docId: string;
  onReady: () => void;
  onFailed?: () => void;
  onSignedOut: () => void;
}

export function CreationStatus({ tenantId, docType, docId, onReady, onFailed, onSignedOut }: CreationStatusProps) {
  const [status, setStatus] = useState<GatewayDocumentStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function check() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setChecking(true); setError("");
    try {
      const result = await documentStatus(tenantId, docType, docId, controller.signal);
      if (controller.signal.aborted) return;
      setStatus(result);
      if (result.state === "ready") onReady();
      if (result.state === "failed") onFailed?.();
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) onSignedOut();
      else setError(reason instanceof Error ? reason.message : String(reason));
    } finally { request.current = null; if (!controller.signal.aborted) setChecking(false); }
  }

  const ready = status?.state === "ready";
  const failed = status?.state === "failed";
  return <section className="workspace-creation-status" aria-label={`创建状态 ${docId}`}>
    <div className="workspace-creation-summary"><span className={`workspace-type-tag ${docType === "psd" ? "type-psd" : "type-md"}`}>{docType === "markdown" ? "MD" : docType.toUpperCase()}</span><span className="workspace-creation-id">{docId}</span>
      <span role="status">{checking ? "正在核实…" : ready ? `已就绪 · v${status.version}` : failed ? "创建失败" : status ? "仍在处理中" : "等待创建完成"}</span>
      {!ready && !failed && <button disabled={checking} onClick={check}><RefreshCw size={14} />检查创建状态</button>}
      {ready && (docType === "markdown" || docType === "psd") && <a className="workspace-action" href={`#/preview/${encodeURIComponent(docType)}/${encodeURIComponent(docId)}`}><Eye size={14} />打开预览</a>}
    </div>
    {failed && <p className="workspace-error" role="alert">服务端确认创建失败，本次检查不会重新创建或覆盖作品。</p>}
    {error && <p className="workspace-error" role="alert">{error}。创建结果尚未确认，可再次检查。</p>}
  </section>;
}