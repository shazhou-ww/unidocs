import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Pencil, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";

interface TypeRecord {
  docType: string; baseUrl: string; enabled: boolean; etag: string; checkedAt: string; updatedAt: string;
  discovered: { displayName: string; description: string; formats: string[]; capabilities: { preview: boolean; edit: boolean } };
}
interface Validation { validationId: string; baseUrl: string; state: string; expiresAt: number; discovered: { docType: string; displayName: string; capabilities: { preview: boolean; edit: boolean } }; }
interface AuditEvent { eventId: string; actorId: string; action: string; targetId: string; targetEmail?: string; occurredAt: string; reason?: string; before?: TypeRecord; after?: TypeRecord; }
interface Command { path: string; method: string; body: string; key: string; etag?: string; }
interface Props { view: "types" | "audit"; csrfToken: string; onDenied: (reason: unknown) => void; }
const errors: Record<string, string> = {
  url_not_approved: "此地址尚未获一方服务策略批准。", invalid_base_url: "请输入无凭据、查询或片段的 HTTPS Base URL。",
  discovery_failed: "未能读取服务描述，请检查地址和服务。", endpoint_unavailable: "服务入口不可用。", redirect_not_allowed: "服务返回了不允许的重定向。",
  unapproved_service_identity: "服务身份与批准配置不符。", service_identity_mismatch: "新地址的服务或存储身份不同，未修改原地址。", doctype_mismatch: "文档类型不匹配。",
  doctype_exists: "该文档类型已登记。", validation_required: "验证已过期或配置已变化，请重新验证。", revision_conflict: "配置已被修改，请关闭并刷新后重试。",
  reauthentication_required: "请重新确认 Google 登录后操作。", idempotency_conflict: "请求标识对应的内容发生变化，请核实原操作。",
};
class CatalogError extends Error { constructor(readonly status: number, readonly code: string) { super(errors[code] ?? `请求未完成（${status}）`); } }

export function AdminCatalog({ view, csrfToken, onDenied }: Props) {
  const [records, setRecords] = useState<TypeRecord[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<TypeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<{ record: TypeRecord | null; mode: "register" | "url" | "status" } | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Command | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const needsValidation = form?.mode !== "status" || enabled;

  async function api(path: string, init?: RequestInit) {
    const response = await fetch(`/admin/api/v1${path}`, { ...init, cache: "no-store", credentials: "same-origin", redirect: "error" });
    const data = await response.json();
    if (!response.ok) throw new CatalogError(response.status, data?.error?.code ?? "unknown");
    return data;
  }
  function failure(value: unknown, inForm = false) {
    if (value instanceof CatalogError && (value.status === 401 || value.code === "administrator_required" || value.code === "identity_mismatch")) {
      setRecords([]); setEvents([]); setForm(null); setSelected(null); pending.current = null; onDenied(value); return;
    }
    if (value instanceof CatalogError && value.code === "reauthentication_required") setReauth(true);
    const message = value instanceof CatalogError ? value.message : "网络异常，未能确认结果。";
    if (inForm) setFormError(message); else setError(message);
  }
  async function load(append = false) {
    const current = ++generation.current; setLoading(true); setError("");
    try {
      const data = await api(view === "audit" ? "/audit-events" : `/document-types?limit=50${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!alive.current || current !== generation.current) return;
      if (view === "audit") setEvents(data.items); else { setRecords(previous => append ? [...previous, ...data.items] : data.items); setCursor(data.nextCursor); }
    } catch (value) { if (alive.current && current === generation.current) failure(value); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => { if (form) dialog.current?.showModal(); }, [form]);
  useEffect(() => {
    if (!form) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [form]);
  function open(record: TypeRecord | null, mode: "register" | "url" | "status") {
    setBaseUrl(record?.baseUrl ?? ""); setEnabled(mode === "status" ? !record!.enabled : record?.enabled ?? false);
    setReason(""); setValidation(null); setFormError(""); setUncertain(false); setReauth(false); pending.current = null;
    setForm({ record, mode });
  }
  function close() {
    if (busy) return;
    if (uncertain && !window.confirm("结果尚未确认。关闭后请先刷新目录核对，不要直接重复提交。")) return;
    dialog.current?.close(); setForm(null); pending.current = null;
  }
  async function validate() {
    if (!form || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFormError(""); setValidation(null);
    try {
      const data = await api("/url-validations", {
        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ baseUrl, ...(form.record ? { expectedDocType: form.record.docType, expectedConfigEtag: form.record.etag } : {}) })
      });
      if (!alive.current) return;
      if (data.data.state !== "passed" || data.data.expiresAt <= Date.now()) throw new CatalogError(422, "validation_required");
      setBaseUrl(data.data.baseUrl); setValidation(data.data);
    } catch (value) { if (alive.current) failure(value, true); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!form || inFlight.current) return;
    if (!pending.current && needsValidation && (!validation || validation.expiresAt <= Date.now() || validation.baseUrl !== baseUrl)) { setValidation(null); setFormError(errors.validation_required); return; }
    const record = form.record;
    const command = pending.current ?? {
      path: record ? `/document-types/${encodeURIComponent(record.docType)}` : "/document-types", method: record ? "PATCH" : "POST", key: crypto.randomUUID(), etag: record?.etag,
      body: JSON.stringify(record ? { ...(form.mode === "url" ? { baseUrl } : {}), enabled, reason, ...(needsValidation ? { validationId: validation!.validationId } : {}) } : { baseUrl, enabled, validationId: validation!.validationId })
    };
    pending.current = command; inFlight.current = true; setBusy(true); setFormError("");
    try {
      let data;
      if (uncertain) {
        try { data = await api(`/changes/${command.key}`); }
        catch (value) { if (!(value instanceof CatalogError && value.status === 404)) throw value; }
      }
      data ??= await api(command.path, { method: command.method, body: command.body, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": command.key, ...(command.etag ? { "If-Match": command.etag } : {}) } });
      if (!alive.current) return;
      pending.current = null; setUncertain(false); dialog.current?.close(); setForm(null); setSelected(data.data); setNotice("配置已保存，尚未接入主站。"); await load();
    } catch (value) {
      if (!alive.current) return;
      const unknown = !(value instanceof CatalogError) || value.status >= 500;
      setUncertain(unknown); if (!unknown) pending.current = null;
      if (value instanceof CatalogError && value.code === "validation_required") setValidation(null);
      failure(value, true);
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  const filtered = records.filter(record => (!filter || String(record.enabled) === filter) && `${record.docType} ${record.baseUrl} ${record.discovered.displayName}`.toLowerCase().includes(query.toLowerCase()));
  const audit = events.filter(entry => `${entry.action} ${entry.targetEmail ?? entry.targetId} ${entry.actorId}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="admin-live-heading"><div><small>{view === "audit" ? "ACTIVITY LOG" : "TYPE DIRECTORY"}</small><h1>{view === "audit" ? "审计" : selected?.discovered.displayName ?? "文档类型"}</h1><p>{view === "audit" ? "最近 100 条管理事件" : "尚未接入主站 · 仅保存目标配置"}</p></div><div><button title="刷新" aria-label="刷新目录" disabled={loading} onClick={() => { setSelected(null); void load(); }}><RefreshCw size={16} /></button>{view === "types" && !selected && <button className="primary" onClick={() => open(null, "register")}><Plus size={16} />登记类型</button>}</div></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{reauth && !form && <a href="/admin/auth/login">重新确认 Google 登录</a>}
    {selected && view === "types" ? <><button onClick={() => setSelected(null)}><ArrowLeft size={16} />返回目录</button><dl className="admin-type-details">
      <div><dt>类型 ID</dt><dd>{selected.docType}</dd></div><div><dt>Base URL</dt><dd>{selected.baseUrl}</dd></div><div><dt>服务 API</dt><dd>{new URL("./api/", selected.baseUrl).href}</dd></div><div><dt>编辑器入口</dt><dd>{new URL("./editor/", selected.baseUrl).href}</dd></div><div><dt>目标状态</dt><dd>{selected.enabled ? "启用" : "停用"}（未应用到主站）</dd></div><div><dt>服务能力</dt><dd>{selected.discovered.capabilities.preview ? "提供预览" : "未提供嵌入预览"} · {selected.discovered.capabilities.edit ? "提供编辑" : "未提供嵌入编辑"}</dd></div><div><dt>最近验证</dt><dd>{new Date(selected.checkedAt).toLocaleString()}</dd></div></dl><div className="admin-type-actions"><button onClick={() => open(selected, "url")}><Pencil size={16} />更换 URL</button><button onClick={() => open(selected, "status")}><Check size={16} />{selected.enabled ? "设为停用" : "设为启用"}</button></div></> : <>
      <div className="admin-catalog-filter"><Search size={16} /><input aria-label="搜索目录或审计" placeholder={view === "types" ? "搜索已加载的名称、ID 或 URL" : "搜索最近的动作或目标"} value={query} onChange={event => setQuery(event.target.value)} />{view === "types" && <select aria-label="目标状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="">所有目标状态</option><option value="true">启用</option><option value="false">停用</option></select>}</div>
      {view === "types" ? <table className="admin-catalog-table"><thead><tr><th>文档类型</th><th>Base URL</th><th>目标状态</th><th>操作</th></tr></thead><tbody>{filtered.map(record => <tr key={record.docType}><td>{record.discovered.displayName}<br /><small>{record.docType}</small></td><td>{record.baseUrl}</td><td>{record.enabled ? "启用" : "停用"}</td><td><button aria-label={`查看 ${record.docType}`} onClick={() => setSelected(record)}>查看</button></td></tr>)}</tbody></table> : <table className="admin-catalog-table"><thead><tr><th>时间 / 操作者</th><th>动作</th><th>目标</th><th>详情</th></tr></thead><tbody>{audit.map(entry => <tr key={entry.eventId}><td>{new Date(entry.occurredAt).toLocaleString()}<br /><small>{entry.actorId}</small></td><td>{entry.action}</td><td>{entry.targetEmail ?? entry.targetId}{expanded === entry.eventId && <div className="admin-audit-detail">{entry.reason && <p>{entry.reason}</p>}{entry.before && <p>原地址：{entry.before.baseUrl}<br />原目标状态：{String(entry.before.enabled)}</p>}{entry.after && <p>新地址：{entry.after.baseUrl}<br />新目标状态：{String(entry.after.enabled)}</p>}</div>}</td><td><button onClick={() => setExpanded(expanded === entry.eventId ? null : entry.eventId)}>{expanded === entry.eventId ? "收起" : "详情"}</button></td></tr>)}</tbody></table>}
      {!loading && !error && (view === "types" ? filtered.length : audit.length) === 0 && <p className="admin-catalog-empty">{view === "types" ? "没有匹配的文档类型" : "没有匹配的事件"}</p>}{view === "types" && cursor && <button disabled={loading} onClick={() => void load(true)}>加载更多</button>}
    </>}{loading && <p role="status">正在读取…</p>}
    <dialog ref={dialog} aria-labelledby="catalog-dialog-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={event => void save(event)}><div className="admin-live-dialog-title"><h2 id="catalog-dialog-title">{form?.mode === "register" ? "登记文档类型" : form?.mode === "url" ? "更换 Base URL" : "修改目标状态"}</h2><button type="button" aria-label="关闭目录表单" disabled={busy} onClick={close}><X size={16} /></button></div>
      <label>Base URL<input type="url" required maxLength={2048} value={baseUrl} readOnly={form?.mode === "status"} disabled={busy || uncertain} onChange={event => { setBaseUrl(event.target.value); setValidation(null); setFormError(""); }} /></label>
      {needsValidation && <button className="admin-validate-button" type="button" disabled={busy || uncertain || !baseUrl} onClick={() => void validate()}><ShieldCheck size={16} />验证 URL</button>}
      {validation && <p role="status">已识别 {validation.discovered.displayName}（{validation.discovered.docType}）{!validation.discovered.capabilities.preview && " · 未提供嵌入预览"}</p>}
      <label className="admin-target-state"><input type="checkbox" checked={enabled} disabled={busy || uncertain || form?.mode === "status"} onChange={event => setEnabled(event.target.checked)} />目标启用（尚未接入主站）</label>
      {form?.record && <label>变更原因<input required maxLength={500} value={reason} disabled={busy || uncertain} onChange={event => setReason(event.target.value)} /></label>}
      {formError && <p role="alert">{formError}</p>}{uncertain && <p role="status">结果待确认；核实后仍未知时会重试原请求。</p>}{reauth && <a href="/admin/auth/login">重新确认 Google 登录</a>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !uncertain && needsValidation && !validation}>{busy ? "处理中…" : uncertain ? "核实并重试" : "保存配置"}</button></footer>
    </form></dialog>
  </>;
}