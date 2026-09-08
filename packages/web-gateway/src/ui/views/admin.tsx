import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LogIn, LogOut, Plus, RefreshCw, ShieldCheck, Trash2, Users, Monitor, X, Shapes, History } from "lucide-react";
import { AdminCatalog } from "./admin-catalog.js";
import logo from "../studio/logo.svg";
import "./admin.css";

interface Administrator { adminId: string; email: string; bound: boolean; addedBy: string; addedAt: string; etag: string; isSelf?: boolean; }
interface ManagementSession extends Administrator { csrfToken: string; expiresAt: number; reauthRequiredAt: number; }
interface Command { method: string; path: string; key: string; body?: string; etag?: string; }
class AdminApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const messages: Record<string, string> = {
  administrator_exists: "该邮箱已在名单中。", invalid_email: "邮箱格式不正确。", administrator_required: "此账号没有运营管理权限。",
  identity_mismatch: "账号身份与已绑定管理员不匹配。", self_removal_forbidden: "不能删除自己。", revision_conflict: "名单已发生变化，请关闭弹窗并刷新后重试。",
  reauthentication_required: "此操作需要重新验证 Google 身份。", admin_unavailable: "管理服务暂不可用。", csrf_rejected: "会话校验失败，请退出管理后重新进入。",
  google_login_required: "Google 登录确认未能恢复，请重新发起登录。", login_required: "管理会话尚未建立，请重新进入。",
};

export function AdminView() {
  const [view, setView] = useState<"admins" | "types" | "audit">("admins");
  const [mobile] = useState(() => window.matchMedia?.("(max-width: 760px)").matches ?? false);
  const [returnedFromGoogle] = useState(() => new URLSearchParams(window.location.search).get("google") === "complete");
  const [session, setSession] = useState<ManagementSession | null>(null);
  const [items, setItems] = useState<Administrator[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(!mobile);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [modal, setModal] = useState<"add" | Administrator | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [formError, setFormError] = useState("");
  const command = useRef<Command | null>(null);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);

  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.status === 204) return null;
    const body = await response.json();
    if (!response.ok) throw new AdminApiError(response.status, body?.error?.code ?? "admin_unavailable");
    return body;
  }

  function report(reason: unknown, form = false) {
    const api = reason instanceof AdminApiError ? reason : reason instanceof Error && "status" in reason && "code" in reason ? reason as AdminApiError : null;
    const text = api ? messages[api.code] ?? `请求未完成（${api.status}）。` : "网络异常，尚未确认请求结果。";
    if (api?.code === "reauthentication_required") setReauth(true);
    if (api && (api.status === 401 || api.code === "administrator_required" || api.code === "identity_mismatch")) {
      setSession(null); setItems([]); setModal(null); setEmail(""); command.current = null; setUncertain(false);
    }
    if (form) setFormError(text); else setError(text);
  }

  async function load(append = false) {
    setLoading(true); setError("");
    try {
      const identity = await request("/admin/api/v1/session");
      if (!alive.current) return;
      const records = await request(`/admin/api/v1/administrators?limit=50${append && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!alive.current) return;
      setSession(identity.data); setItems(previous => append ? [...previous, ...records.items] : records.items); setCursor(records.nextCursor);
    } catch (reason) {
      if (!alive.current) return;
      if (reason instanceof AdminApiError && reason.status === 401) { setSession(null); setItems([]); }
      else report(reason);
    } finally { if (alive.current) setLoading(false); }
  }

  useEffect(() => {
    alive.current = true;
    if (!mobile) {
      if (returnedFromGoogle) {
        const url = new URL(window.location.href);
        url.searchParams.delete("google");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
        void enter(false);
      } else void load();
    }
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { if (modal && !dialog.current?.open) dialog.current?.showModal(); else if (!modal && dialog.current?.open) dialog.current.close(); }, [modal]);

  async function enter(redirectToGoogle = true) {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError("");
    try {
      await request("/admin/auth/session", { method: "POST", headers: { "X-UniDocs-Admin": "1" } });
      if (!alive.current) return;
      await load();
    } catch (reason) {
      if (!alive.current) return;
      if (redirectToGoogle && reason instanceof AdminApiError && reason.status === 401) { window.location.assign("/admin/auth/login"); return; }
      report(reason);
    } finally { inFlight.current = false; if (alive.current) setLoading(false); }
  }

  async function logout() {
    if (!session || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      await request("/admin/api/v1/session/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrfToken } });
      setSession(null); setItems([]); setModal(null); setEmail(""); setReauth(false); command.current = null; setUncertain(false); setError("");
    } catch (reason) { report(reason); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!session || !modal || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFormError("");
    const next = command.current ?? (modal === "add"
      ? { method: "POST", path: "/admin/api/v1/administrators", key: crypto.randomUUID(), body: JSON.stringify({ email: email.trim() }) }
      : { method: "DELETE", path: `/admin/api/v1/administrators/${encodeURIComponent(modal.adminId)}`, key: crypto.randomUUID(), etag: modal.etag });
    command.current = next;
    try {
      await request(next.path, { method: next.method, headers: { "X-CSRF-Token": session.csrfToken, "Idempotency-Key": next.key, ...(next.body ? { "Content-Type": "application/json" } : {}), ...(next.etag ? { "If-Match": next.etag } : {}) }, body: next.body });
      command.current = null; setUncertain(false); setModal(null); setEmail(""); await load();
    } catch (reason) {
      const unknown = !(reason instanceof AdminApiError) || reason.status >= 500;
      setUncertain(unknown); if (!unknown) command.current = null;
      report(reason, true);
    } finally { inFlight.current = false; setBusy(false); }
  }

  function close() { if (busy || uncertain) return; setModal(null); command.current = null; setFormError(""); }
  const reauthenticate = <a href="/admin/auth/login">重新验证 Google 身份</a>;
  if (mobile) return <main className="admin-device-screen"><img src={logo} alt="UniDocs" /><Monitor /><h1>请在电脑或平板上查看</h1></main>;
  if (!session) return <main className="admin-login-screen"><img src={logo} alt="UniDocs" /><h1>UniDocs 运营</h1>{error && <p role="alert">{error}</p>}<button disabled={loading} onClick={() => void enter()}><LogIn size={16} />{loading ? "正在确认身份…" : "使用 UniDocs Google 账号进入"}</button><a href="/ui/#/documents"><ArrowLeft size={14} />返回工作台</a></main>;
  return <div className="admin-live">
    <aside><a className="admin-live-brand" href="/admin/"><img src={logo} alt="" />UniDocs</a><p>运营工作空间</p>
      <nav aria-label="运营导航">
        <button aria-current={view === "types" ? "page" : undefined} onClick={() => setView("types")}><Shapes size={16} />文档类型</button>
        <button aria-current={view === "admins" ? "page" : undefined} onClick={() => { setView("admins"); void load(); }}><Users size={16} />管理员</button>
        <button aria-current={view === "audit" ? "page" : undefined} onClick={() => setView("audit")}><History size={16} />审计</button>
      </nav>
      <div className="admin-live-account"><span>{session.email}</span><button title="退出管理" disabled={busy} onClick={() => void logout()}><LogOut size={16} />退出管理</button></div>
    </aside>
    <main><header><span>运营工作空间 / {view === "admins" ? "管理员" : view === "types" ? "文档类型" : "审计"}</span><ShieldCheck size={16} /></header><section>
      {view !== "admins" ? <AdminCatalog key={`${session.adminId}:${view}`} view={view} csrfToken={session.csrfToken} onDenied={report} /> : <>
        <div className="admin-live-heading"><div><small>ACCESS CONTROL</small><h1>管理员</h1><p>Google 账号邮箱名单</p></div><div><button aria-label="刷新名单" title="刷新名单" disabled={loading} onClick={() => void load()}><RefreshCw size={16} /></button><button className="primary" onClick={() => { setModal("add"); setEmail(""); setFormError(""); setUncertain(false); command.current = null; }}><Plus size={16} />添加管理员</button></div></div>
        {error && <p role="alert">{error}</p>}{reauth && <p>{reauthenticate}</p>}
        <table><thead><tr><th>管理员邮箱</th><th>Google 身份</th><th>添加时间</th><th>操作</th></tr></thead><tbody>{items.map(item => <tr key={item.adminId}><td>{item.email}{item.isSelf && <small>你</small>}</td><td>{item.bound ? "已绑定" : "尚未登录"}</td><td>{new Date(item.addedAt).toLocaleDateString()}</td><td><button aria-label={item.isSelf ? "不能删除自己" : `删除 ${item.email}`} title={item.isSelf ? "不能删除自己" : "删除管理员"} disabled={item.isSelf} onClick={() => { setModal(item); setFormError(""); setUncertain(false); command.current = null; }}><Trash2 size={16} /></button></td></tr>)}</tbody></table>
        {loading && <p role="status">正在读取名单…</p>}{cursor && <button disabled={loading} onClick={() => void load(true)}>加载更多</button>}
      </>}
    </section></main>
    <dialog ref={dialog} aria-labelledby="admin-dialog-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={event => void submit(event)}><div className="admin-live-dialog-title"><h2 id="admin-dialog-title">{modal === "add" ? "添加管理员" : "删除管理员"}</h2><button type="button" aria-label="关闭" disabled={busy || uncertain} onClick={close}><X size={16} /></button></div>{modal === "add" ? <label>Google 账号邮箱<input type="email" required maxLength={254} value={email} disabled={busy || uncertain} onChange={event => setEmail(event.target.value)} /></label> : <p>{modal?.email}</p>}{formError && <p role="alert">{formError}</p>}{uncertain && <p role="status">结果待确认。重试将使用原请求，不会新建操作。</p>}{reauth && <p>{reauthenticate}</p>}<footer><button type="button" disabled={busy || uncertain} onClick={close}>取消</button><button type="submit" disabled={busy} className="primary">{busy ? "正在处理…" : uncertain ? "重试原请求" : modal === "add" ? "添加" : "确认删除"}</button></footer></form></dialog>
  </div>;
}