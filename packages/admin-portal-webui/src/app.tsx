import { startTransition, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, BookOpenText, Check, ChevronRight, CircleDashed, FileText, LoaderCircle, LogIn, LogOut, Menu, Plus, RefreshCw, ScrollText, Search, ShieldAlert, Trash2, UserPlus, Users, X } from "lucide-react";
import { AdminPortalClientError, createAdminPortalClient, type AdminPortalSession } from "@unidocs/admin-portal-client";
import { AdministratorMemberAuditActions, DocumentTypeAuditActions, type AdminAuditEvent, type AdministratorMemberListItem, type DocumentTypeListItem, type DocumentTypeRegistration } from "@unidocs/protocol-admin-portal";

const auditActionLabels: Record<AdminAuditEvent["action"], string> = {
  "type_card_bundle.uploaded": "上传类型卡片包",
  "type_card_bundle.validation_failed": "类型卡片包验证失败",
  "type_card_bundle.metadata_changed": "修改类型卡片包信息",
  "view_bundle.uploaded": "上传视图包",
  "view_bundle.validation_failed": "视图包验证失败",
  "view_bundle.metadata_changed": "修改视图包信息",
  "operator.created": "创建算子",
  "operator.metadata_changed": "修改算子信息",
  "document_contract.appended": "添加文档契约版本",
  "administrator.bootstrap": "初始化管理员",
  "administrator.bound": "绑定管理员身份",
  "administrator.added": "添加管理员",
  "administrator.removed": "移除管理员",
  "document_type.registered": "创建文档类型",
  "document_type.internal_name_changed": "修改内部名称",
  "document_type.type_card_bundle_changed": "切换类型卡片包",
  "document_type.view_bundle_changed": "切换视图包",
  "document_type.operator_changed": "切换内置算子",
  "document_type.enabled": "启用文档类型",
  "document_type.disabled": "停用文档类型",
  "operator.validation_passed": "算子验证通过",
  "operator.validation_failed": "算子验证失败",
};

const resourceLabels: Record<AdminAuditEvent["resourceType"], string> = {
  administrator: "管理员",
  document_type: "文档类型",
  document_contract: "文档契约",
  type_card_bundle: "类型卡片包",
  view_bundle: "视图包",
  operator: "算子",
  operator_validation: "算子验证",
};

function auditActionLabel(action: AdminAuditEvent["action"]) {
  return auditActionLabels[action];
}

const auditActions = [...AdministratorMemberAuditActions, ...DocumentTypeAuditActions];

function actionResource(action: AdminAuditEvent["action"]): AdminAuditEvent["resourceType"] {
  if (action.startsWith("administrator.")) return "administrator";
  if (action.startsWith("document_type.")) return "document_type";
  if (action.startsWith("document_contract.")) return "document_contract";
  if (action.startsWith("type_card_bundle.")) return "type_card_bundle";
  if (action.startsWith("view_bundle.")) return "view_bundle";
  if (action.startsWith("operator.validation_")) return "operator_validation";
  return "operator";
}

function administratorName(email: string) {
  return email.slice(0, email.lastIndexOf("@"));
}

type AdminView = "documentTypes" | "administrators" | "audit";
type DocumentTypeTab = "config" | "contracts" | "cards" | "bundles" | "operators" | "changes";
interface AdminRoute {
  readonly view: AdminView;
  readonly documentType?: string;
  readonly tab?: DocumentTypeTab;
}

const documentTypeTabs = new Set<DocumentTypeTab>(["config", "contracts", "cards", "bundles", "operators", "changes"]);

export function parseAdminRoute(url: string | URL): AdminRoute {
  const parsed = typeof url === "string" ? new URL(url, "https://portal.invalid") : url;
  if (parsed.pathname === "/admin/administrators") return { view: "administrators" };
  if (parsed.pathname === "/admin/audit") return { view: "audit" };
  const match = /^\/admin\/document-types\/([A-Za-z0-9!$&^_.+-]+)$/.exec(parsed.pathname);
  if (match) {
    const requestedTab = parsed.searchParams.get("tab") as DocumentTypeTab | null;
    return { view: "documentTypes", documentType: match[1], tab: requestedTab && documentTypeTabs.has(requestedTab) ? requestedTab : "config" };
  }
  return { view: "documentTypes" };
}

export function adminRoutePath(route: AdminRoute): string {
  if (route.view === "administrators") return "/admin/administrators";
  if (route.view === "audit") return "/admin/audit";
  if (route.documentType) return `/admin/document-types/${encodeURIComponent(route.documentType)}?tab=${route.tab ?? "config"}`;
  return "/admin/document-types";
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminPortalClientError) {
    if (error.status === 401) return "登录已失效，请重新登录。";
    if (error.code === "idempotency_conflict") return "请求标识已被另一项操作使用。";
    if (error.code === "administrator_exists") return "这个邮箱已经在管理员列表中。";
    if (error.code === "cannot_remove_self") return "不能移除当前登录的管理员。";
    if (error.code === "last_administrator") return "不能移除最后一位可登录管理员。";
    if (error.code === "precondition_failed") return "成员信息已发生变化，请刷新后重试。";
    return `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ""}`;
  }
  return "暂时无法连接管理服务。";
}

function shortEtag(etag: string): string {
  return etag.length > 24 ? `${etag.slice(0, 18)}...${etag.slice(-5)}` : etag;
}

export function sessionInvalidPath(error: AdminPortalClientError): string {
  const params = new URLSearchParams({ code: "session_invalid" });
  if (error.requestId) params.set("requestId", error.requestId);
  return `/admin/access-denied?${params}`;
}

export async function logoutToLogin(logout: () => Promise<void>, navigate: (path: string) => void = path => window.location.assign(path)) {
  try {
    await logout();
  } catch {
    // Logout is idempotent from the browser's perspective; the next page is public.
  } finally {
    navigate("/admin/login");
  }
}

export async function returnToAppWhenAuthenticated(session: () => Promise<unknown>, navigate: (path: string) => void = path => window.location.replace(path)) {
  try {
    await session();
    navigate("/admin/");
    return true;
  } catch {
    return false;
  }
}

function SessionCheck() {
  return <main className="access-page">
    <section className="access-panel checking-panel" role="status">
      <div className="brand access-brand"><span className="brand-mark">U</span><span><strong>UniDocs</strong><small>管理控制台</small></span></div>
      <LoaderCircle className="spin" size={24} aria-hidden="true" />
      <h1>正在确认登录状态</h1>
    </section>
  </main>;
}

function usePublicPageReady(session: () => Promise<unknown>) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void returnToAppWhenAuthenticated(session).then(authenticated => {
      if (active && !authenticated) setReady(true);
    });
    return () => { active = false; };
  }, [session]);
  return ready;
}

function LoginPrompt() {
  const [client] = useState(() => createAdminPortalClient());
  const [session] = useState(() => () => client.session());
  const ready = usePublicPageReady(session);
  if (!ready) return <SessionCheck />;
  return <main className="access-page">
    <section className="access-panel">
      <div className="brand access-brand"><span className="brand-mark">U</span><span><strong>UniDocs</strong><small>管理控制台</small></span></div>
      <span className="access-icon login-icon" aria-hidden="true"><LogIn size={24} /></span>
      <p className="eyebrow">ADMINISTRATOR SIGN IN</p>
      <h1>登录管理控制台</h1>
      <p>使用已加入管理员列表的 Google Account 登录。</p>
      <a className="primary-button access-action" href="/admin/auth/login"><LogIn size={17} />使用 Google Account 登录</a>
    </section>
  </main>;
}

function AccessDenied() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const requestId = params.get("requestId");
  const forbidden = code === "forbidden";
  const sessionInvalid = code === "session_invalid";
  const [client] = useState(() => createAdminPortalClient());
  const [session] = useState(() => () => client.session());
  const ready = usePublicPageReady(session);
  if (!ready) return <SessionCheck />;
  return <main className="access-page">
    <section className="access-panel">
      <div className="brand access-brand"><span className="brand-mark">U</span><span><strong>UniDocs</strong><small>管理控制台</small></span></div>
      <span className="access-icon" aria-hidden="true"><ShieldAlert size={24} /></span>
      <p className="eyebrow">ACCESS NOT GRANTED</p>
      <h1>{sessionInvalid ? "管理员权限已失效" : forbidden ? "没有管理员权限" : "登录未完成"}</h1>
      <p>{sessionInvalid ? "当前 session 已失效，管理员成员可能已被移除。请退出后重新登录。" : forbidden ? "当前 Google 账户尚未加入管理员列表，或成员资格已失效。" : "登录请求已过期或未能通过验证，请重新开始。"}</p>
      {requestId && <div className="request-reference"><span>请求 ID</span><code>{requestId}</code></div>}
      <button className="primary-button access-action" type="button" onClick={() => void logoutToLogin(() => client.logout())}><LogOut size={17} />退出并返回登录</button>
      <small>需要由现有管理员先将 Google 账户邮箱加入 allowlist。</small>
    </section>
  </main>;
}

function AdminApp() {
  const [client] = useState(() => createAdminPortalClient({ onUnauthorized: error => window.location.replace(sessionInvalidPath(error)) }));
  const [initialRoute] = useState(() => parseAdminRoute(window.location.href));
  const [view, setView] = useState<AdminView>(initialRoute.view);
  const [session, setSession] = useState<AdminPortalSession | null>(null);
  const [items, setItems] = useState<readonly DocumentTypeListItem[]>([]);
  const [members, setMembers] = useState<readonly AdministratorMemberListItem[]>([]);
  const [selected, setSelected] = useState<DocumentTypeRegistration | null>(null);
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<"all" | "true" | "false">("all");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [internalName, setInternalName] = useState("");
  const [saving, setSaving] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberToRemove, setMemberToRemove] = useState<AdministratorMemberListItem | null>(null);
  const [auditEvents, setAuditEvents] = useState<readonly AdminAuditEvent[]>([]);
  const [selectedAudit, setSelectedAudit] = useState<AdminAuditEvent | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditAction, setAuditAction] = useState<AdminAuditEvent["action"] | "all">("all");
  const [auditResource, setAuditResource] = useState<AdminAuditEvent["resourceType"] | "all">("all");
  const [mobileNav, setMobileNav] = useState(false);

  async function loadTypes(nextQuery = query, nextEnabled = enabled) {
    setLoading(true);
    setError(null);
    try {
      const page = await client.listDocumentTypes({ q: nextQuery || undefined, enabled: nextEnabled === "all" ? undefined : nextEnabled === "true", limit: 50 });
      startTransition(() => setItems(page.items));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([client.session(), client.listDocumentTypes({ limit: 50 })]).then(([nextSession, page]) => {
      if (!active) return;
      setSession(nextSession);
      setItems(page.items);
    }).catch(caught => { if (active) setError(errorMessage(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (initialRoute.view === "administrators") void loadMembers();
    if (initialRoute.view === "audit") {
      void loadMembers();
      void loadAudit();
    }
    if (initialRoute.documentType) void openDetail(initialRoute.documentType, false);
    const handlePopState = () => applyRoute(parseAdminRoute(window.location.href));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  async function openDetail(documentType: string, updateRoute = true) {
    if (updateRoute) window.history.pushState({}, "", adminRoutePath({ view: "documentTypes", documentType, tab: "config" }));
    setDetailLoading(true);
    setError(null);
    try { setSelected(await client.getDocumentType(documentType)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setDetailLoading(false); }
  }

  async function loadMembers() {
    setMembersLoading(true);
    setError(null);
    try {
      const page = await client.listAdministrators({ limit: 100 });
      startTransition(() => setMembers(page.items));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setMembersLoading(false);
    }
  }

  async function loadAudit(cursor: string | null = null, nextAction = auditAction, nextResource = auditResource) {
    setAuditLoading(true);
    setError(null);
    try {
      const page = await client.listAuditEvents({
        action: nextAction === "all" ? undefined : nextAction,
        resourceType: nextResource === "all" ? undefined : nextResource,
        cursor: cursor ?? undefined,
        limit: 25,
      });
      startTransition(() => setAuditEvents(current => cursor ? [...current, ...page.items] : page.items));
      setAuditCursor(page.nextCursor);
      if (!cursor) setSelectedAudit(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setAuditLoading(false);
    }
  }

  function actorMember(actorId: string) {
    return members.find(member => member.adminId === actorId) ?? null;
  }

  function actorIdentity(actorId: string) {
    const member = actorMember(actorId);
    return member ? { name: administratorName(member.email), email: member.email } : null;
  }

  function applyRoute(route: AdminRoute) {
    setView(route.view);
    setSelected(null);
    setSelectedAudit(null);
    if (route.view === "documentTypes" && route.documentType) void openDetail(route.documentType, false);
    if (route.view === "administrators") void loadMembers();
    if (route.view === "audit") {
      if (members.length === 0) void loadMembers();
      void loadAudit();
    }
  }

  function navigate(route: AdminRoute) {
    window.history.pushState({}, "", adminRoutePath(route));
    applyRoute(route);
  }

  function showView(nextView: AdminView) {
    navigate({ view: nextView });
    setMobileNav(false);
  }

  async function createType(event: FormEvent) {
    event.preventDefault();
    if (!internalName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await client.createDocumentType({ internalName: internalName.trim() });
      setCreateOpen(false);
      setInternalName("");
      await loadTypes();
      await openDetail(created.documentType);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSaving(false); }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    if (!memberEmail.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await client.addAdministrator({ email: memberEmail.trim() });
      setAddMemberOpen(false);
      setMemberEmail("");
      await loadMembers();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemoveMember() {
    if (!memberToRemove) return;
    setSaving(true);
    setError(null);
    try {
      await client.removeAdministrator(memberToRemove.adminId, memberToRemove.etag);
      setMemberToRemove(null);
      await loadMembers();
    } catch (caught) {
      setMemberToRemove(null);
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await logoutToLogin(() => client.logout());
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void loadTypes();
  }

  const navigation = <>
    <div className="brand"><span className="brand-mark">U</span><span><strong>UniDocs</strong><small>管理控制台</small></span></div>
    <nav aria-label="管理导航">
      <button className={`nav-item ${view === "documentTypes" ? "active" : ""}`} type="button" onClick={() => showView("documentTypes")}><BookOpenText size={17} />文档类型</button>
      <button className={`nav-item ${view === "administrators" ? "active" : ""}`} type="button" onClick={() => showView("administrators")}><Users size={17} />管理员</button>
      <button className={`nav-item ${view === "audit" ? "active" : ""}`} type="button" onClick={() => showView("audit")}><ScrollText size={17} />审计</button>
    </nav>
    <div className="account">
      <div className="avatar" aria-hidden="true">{session?.email.slice(0, 1).toUpperCase() || "U"}</div>
      <div><strong>{session?.email || "正在读取账户"}</strong><small>Administrator</small></div>
      <button className="icon-button" type="button" onClick={() => void logout()} title="退出登录" aria-label="退出登录"><LogOut size={17} /></button>
    </div>
  </>;

  return <div className="app-shell">
    <aside className="sidebar">{navigation}</aside>
    <header className="mobile-header"><div className="brand compact"><span className="brand-mark">U</span><strong>UniDocs</strong></div></header>
    <main>
      {view === "documentTypes" ? <>
        <section className="page-heading">
          <div><p className="eyebrow">CONTENT REGISTRY</p><h1>文档类型</h1><p>管理可用文档格式与运行依赖。</p></div>
          <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}><Plus size={17} />新建类型</button>
        </section>

        <section className="toolbar" aria-label="文档类型筛选">
          <form className="search-form" onSubmit={submitSearch}>
            <Search size={16} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称或 ID 搜索" aria-label="搜索文档类型" />
          </form>
          <label className="select-control"><span>状态</span><select value={enabled} onChange={event => { const value = event.target.value as typeof enabled; setEnabled(value); void loadTypes(query, value); }}><option value="all">全部</option><option value="true">已启用</option><option value="false">草稿</option></select></label>
          <button className="icon-button bordered" type="button" onClick={() => void loadTypes()} title="刷新" aria-label="刷新文档类型"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
        </section>

        {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={16} /></button></div>}

        <section className="workspace">
          <div className="table-region">
            <div className="table-meta"><span>{loading ? "正在同步" : `${items.length} 个类型`}</span><span>最多显示 50 项</span></div>
            <div className="table-scroll">
              <table><thead><tr><th>文档类型</th><th>状态</th><th>Contract</th><th>资源</th><th><span className="sr-only">详情</span></th></tr></thead>
                <tbody>{items.map(item => <tr key={item.documentType} className={selected?.documentType === item.documentType ? "selected-row" : ""} onClick={() => void openDetail(item.documentType)}>
                  <td><div className="type-name"><span className="file-icon"><FileText size={17} /></span><span><strong>{item.internalName}</strong><code>{item.documentType}</code></span></div></td>
                  <td><span className={`status ${item.enabled ? "enabled" : "draft"}`}>{item.enabled ? <Check size={13} /> : <CircleDashed size={13} />}{item.enabled ? "已启用" : "草稿"}</span></td>
                  <td>{item.latestDocumentContractIdx === null ? <span className="muted">未配置</span> : `r${item.latestDocumentContractIdx}`}</td>
                  <td><span className="resource-count">{[item.typeCardBundle, item.viewBundle, item.builtinOperator].filter(Boolean).length}/3</span></td>
                  <td><ChevronRight size={16} className="row-arrow" /></td>
                </tr>)}</tbody>
              </table>
              {!loading && items.length === 0 && <div className="empty-state"><BookOpenText size={28} /><strong>没有匹配的文档类型</strong><span>调整筛选条件，或创建一个新的草稿。</span></div>}
              {loading && items.length === 0 && <div className="empty-state"><LoaderCircle className="spin" size={26} /><strong>正在读取文档类型</strong></div>}
            </div>
          </div>

          <aside className={`detail-panel ${selected || detailLoading ? "open" : ""}`} aria-label="文档类型详情">
            {detailLoading ? <div className="detail-placeholder"><LoaderCircle className="spin" size={22} />正在读取</div> : selected ? <>
              <div className="detail-header"><div><span>类型详情</span><h2>{selected.internalName}</h2><code>{selected.documentType}</code></div><button className="icon-button" type="button" onClick={() => navigate({ view: "documentTypes" })} aria-label="关闭详情"><X size={17} /></button></div>
              <dl className="detail-list"><div><dt>状态</dt><dd>{selected.enabled ? "已启用" : "草稿"}</dd></div><div><dt>Document Contract</dt><dd>{selected.latestDocumentContract ? `r${selected.latestDocumentContract.documentContractIdx}` : "未配置"}</dd></div><div><dt>Type Card</dt><dd>{selected.typeCardBundle?.name ?? "未选择"}</dd></div><div><dt>View bundle</dt><dd>{selected.viewBundle?.name ?? "未选择"}</dd></div><div><dt>内置 Operator</dt><dd>{selected.builtinOperator?.name ?? "未选择"}</dd></div><div><dt>ETag</dt><dd><code title={selected.etag}>{shortEtag(selected.etag)}</code></dd></div></dl>
              <div className="readiness"><strong>启用准备度</strong><div className="readiness-track"><span className={`progress-${[selected.latestDocumentContract, selected.typeCardBundle, selected.viewBundle, selected.builtinOperator].filter(Boolean).length}`} /></div><small>需要 Contract、Type Card、View 与 Operator。</small></div>
            </> : <div className="detail-placeholder"><FileText size={24} /><span>选择一行查看完整配置</span></div>}
          </aside>
        </section>
      </> : view === "administrators" ? <>
        <section className="page-heading">
          <div><p className="eyebrow">ACCESS CONTROL</p><h1>管理员</h1><p>管理可登录 UniDocs 管理控制台的 Google 账户。</p></div>
          <button className="primary-button" type="button" onClick={() => setAddMemberOpen(true)}><UserPlus size={17} />添加管理员</button>
        </section>
        {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={16} /></button></div>}
        <section className="workspace members-workspace">
          <div className="table-region">
            <div className="table-meta"><span>{membersLoading ? "正在同步" : `${members.length} 位管理员`}</span><button className="icon-button bordered" type="button" onClick={() => void loadMembers()} title="刷新" aria-label="刷新管理员"><RefreshCw className={membersLoading ? "spin" : ""} size={17} /></button></div>
            <div className="table-scroll">
              <table className="members-table"><thead><tr><th>Google 账户</th><th>身份状态</th><th>添加时间</th><th>成员</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>{members.map(member => <tr key={member.adminId}>
                  <td><div className="type-name"><span className="avatar member-avatar" aria-hidden="true">{member.email.slice(0, 1).toUpperCase()}</span><span><strong>{member.email}</strong><code>{member.adminId}</code></span></div></td>
                  <td><span className={`status ${member.bound ? "enabled" : "draft"}`}>{member.bound ? <Check size={13} /> : <CircleDashed size={13} />}{member.bound ? "已绑定" : "等待登录"}</span></td>
                  <td><time dateTime={member.addedAt}>{new Date(member.addedAt).toLocaleDateString("zh-CN")}</time></td>
                  <td>{member.isSelf ? <span className="self-badge">当前账户</span> : <span className="muted">管理员</span>}</td>
                  <td>{!member.isSelf && <button className="icon-button danger-icon" type="button" onClick={() => setMemberToRemove(member)} title="移除管理员" aria-label={`移除 ${member.email}`}><Trash2 size={16} /></button>}</td>
                </tr>)}</tbody>
              </table>
              {!membersLoading && members.length === 0 && <div className="empty-state"><Users size={28} /><strong>还没有管理员成员</strong></div>}
              {membersLoading && members.length === 0 && <div className="empty-state"><LoaderCircle className="spin" size={26} /><strong>正在读取管理员</strong></div>}
            </div>
          </div>
        </section>
      </> : <>
        <section className="page-heading">
          <div><p className="eyebrow">CONTROL PLANE HISTORY</p><h1>审计</h1><p>查看管理员控制面的不可变操作记录。</p></div>
          <button className="icon-button bordered" type="button" onClick={() => void loadAudit()} title="刷新" aria-label="刷新审计"><RefreshCw className={auditLoading ? "spin" : ""} size={17} /></button>
        </section>
        <section className="toolbar" aria-label="审计筛选">
          <label className="select-control"><span>资源</span><select aria-label="审计资源" value={auditResource} onChange={event => { const value = event.target.value as typeof auditResource; const compatibleAction = auditAction === "all" || value === "all" || actionResource(auditAction) === value ? auditAction : "all"; setAuditResource(value); setAuditAction(compatibleAction); void loadAudit(null, compatibleAction, value); }}><option value="all">全部资源</option>{Object.entries(resourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="select-control"><span>动作</span><select aria-label="审计动作" value={auditAction} onChange={event => { const value = event.target.value as typeof auditAction; setAuditAction(value); void loadAudit(null, value, auditResource); }}><option value="all">全部动作</option>{auditActions.filter(action => auditResource === "all" || actionResource(action) === auditResource).map(action => <option key={action} value={action}>{auditActionLabel(action)}</option>)}</select></label>
        </section>
        {error && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={16} /></button></div>}
        <section className="workspace audit-workspace">
          <div className="table-region">
            <div className="table-meta"><span>{auditLoading && auditEvents.length === 0 ? "正在同步" : `${auditEvents.length} 条事件`}</span><span>按时间倒序</span></div>
            <div className="table-scroll">
              <table className="audit-table"><thead><tr><th>时间</th><th>动作</th><th>资源</th><th>操作者</th><th><span className="sr-only">详情</span></th></tr></thead>
                <tbody>{auditEvents.map(event => <tr key={event.auditEventId} className={selectedAudit?.auditEventId === event.auditEventId ? "selected-row" : ""} onClick={() => setSelectedAudit(event)}>
                  <td><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time></td>
                  <td><strong>{auditActionLabel(event.action)}</strong><code>{event.action}</code></td>
                  <td><strong>{resourceLabels[event.resourceType]}</strong><code>{event.resourceId}</code></td>
                  <td>{actorIdentity(event.actorId) ? <span className="actor-identity"><strong>{actorIdentity(event.actorId)!.name}</strong><small>{actorIdentity(event.actorId)!.email}</small></span> : <code>{event.actorId}</code>}</td>
                  <td><ChevronRight size={16} className="row-arrow" /></td>
                </tr>)}</tbody>
              </table>
              {!auditLoading && auditEvents.length === 0 && <div className="empty-state"><ScrollText size={28} /><strong>没有匹配的审计事件</strong><span>调整筛选条件后重试。</span></div>}
              {auditLoading && auditEvents.length === 0 && <div className="empty-state"><LoaderCircle className="spin" size={26} /><strong>正在读取审计事件</strong></div>}
              {auditCursor && <div className="load-more"><button className="secondary-button" type="button" disabled={auditLoading} onClick={() => void loadAudit(auditCursor)}>{auditLoading ? <LoaderCircle className="spin" size={16} /> : null}加载更多</button></div>}
            </div>
          </div>
          <aside className={`detail-panel ${selectedAudit ? "open" : ""}`} aria-label="审计事件详情">
            {selectedAudit ? <>
              <div className="detail-header"><div><span>事件详情</span><h2>{auditActionLabel(selectedAudit.action)}</h2><code>{selectedAudit.auditEventId}</code></div><button className="icon-button" type="button" onClick={() => setSelectedAudit(null)} aria-label="关闭详情"><X size={17} /></button></div>
              <dl className="detail-list audit-detail"><div><dt>时间</dt><dd>{new Date(selectedAudit.occurredAt).toLocaleString("zh-CN")}</dd></div><div><dt>Request ID</dt><dd><code>{selectedAudit.requestId}</code></dd></div><div><dt>操作者</dt><dd>{actorIdentity(selectedAudit.actorId) ? <><strong>{actorIdentity(selectedAudit.actorId)!.name}</strong><small>{actorIdentity(selectedAudit.actorId)!.email}</small><code>{selectedAudit.actorId}</code></> : <code>{selectedAudit.actorId}</code>}</dd></div><div><dt>资源</dt><dd><code>{selectedAudit.resourceType}/{selectedAudit.resourceId}</code></dd></div><div><dt>文档类型</dt><dd>{selectedAudit.documentType ?? "—"}</dd></div><div><dt>原因</dt><dd>{selectedAudit.reason ?? "—"}</dd></div></dl>
              {selectedAudit.details !== undefined && <div className="audit-details-json"><strong>详情</strong><pre>{JSON.stringify(selectedAudit.details, null, 2)}</pre></div>}
            </> : <div className="detail-placeholder"><ScrollText size={24} /><span>选择一条事件查看详情</span></div>}
          </aside>
        </section>
      </>}
    </main>

    <button className="mobile-menu-button" type="button" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>
    {mobileNav && <div className="mobile-nav-layer" onClick={() => setMobileNav(false)}><aside onClick={event => event.stopPropagation()}><button className="mobile-close icon-button" type="button" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button>{navigation}</aside></div>}

    {createOpen && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCreateOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="modal-header"><div><span>NEW DOCUMENT TYPE</span><h2 id="create-title">新建文档类型</h2></div><button className="icon-button" type="button" onClick={() => setCreateOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={createType}><label><span>内部名称</span><input autoFocus maxLength={256} value={internalName} onChange={event => setInternalName(event.target.value)} placeholder="例如：Markdown" /></label><p>新类型将以未启用草稿创建。</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setCreateOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !internalName.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建草稿</button></div></form>
      </section>
    </div>}
    {addMemberOpen && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setAddMemberOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-member-title"><div className="modal-header"><div><span>ACCESS ALLOWLIST</span><h2 id="add-member-title">添加管理员</h2></div><button className="icon-button" type="button" onClick={() => setAddMemberOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={addMember}><label><span>Google 账户邮箱</span><input autoFocus type="email" value={memberEmail} onChange={event => setMemberEmail(event.target.value)} placeholder="name@gmail.com" /></label><p>该账户首次完成 Google 登录后会绑定身份。</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setAddMemberOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !memberEmail.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}添加成员</button></div></form>
      </section>
    </div>}
    {memberToRemove && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setMemberToRemove(null); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-member-title"><div className="modal-header"><div><span>REMOVE ACCESS</span><h2 id="remove-member-title">移除管理员</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setMemberToRemove(null)} aria-label="关闭"><X size={18} /></button></div>
        <div className="confirm-body"><p>将移除 <strong>{memberToRemove.email}</strong> 的管理员权限，并立即撤销该成员的活动 session。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setMemberToRemove(null)}>取消</button><button className="danger-button" type="button" disabled={saving} onClick={() => void confirmRemoveMember()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}确认移除</button></div></div>
      </section>
    </div>}
  </div>;
}

export function App() {
  if (window.location.pathname === "/admin/login") return <LoginPrompt />;
  if (window.location.pathname === "/admin/access-denied") return <AccessDenied />;
  return <AdminApp />;
}