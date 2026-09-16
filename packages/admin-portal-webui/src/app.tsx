import { startTransition, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, BookOpenText, Check, ChevronRight, CircleDashed, ExternalLink, FileText, Languages, LayoutTemplate, LoaderCircle, LogIn, LogOut, Menu, Pencil, Plus, RefreshCw, ScrollText, Search, ShieldAlert, Trash2, UploadCloud, UserPlus, Users, X } from "lucide-react";
import { AdminPortalClientError, createAdminPortalClient, type AdminPortalSession } from "@unidocs/admin-portal-client";
import { AdministratorMemberAuditActions, DocumentTypeAuditActions, TenantMemberAuditActions, type AdminAuditEvent, type AdministratorMemberListItem, type DocumentContractListItem, type DocumentContractRecord, type DocumentTypeListItem, type DocumentTypeRegistration, type OperatorListItem, type OperatorRecord, type OperatorValidation, type TypeCardBundleListItem, type TypeCardBundleRecord, type ViewBundleListItem, type ViewBundleRecord } from "@unidocs/protocol-admin-portal";

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
  "tenant_member.added": "添加租户成员",
  "tenant_member.removed": "移除租户成员",
  "tenant_member.sessions_revoked": "强制租户成员下线",
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
  tenant_member: "租户成员",
};

function auditActionLabel(action: AdminAuditEvent["action"]) {
  return auditActionLabels[action];
}

const auditActions = [...AdministratorMemberAuditActions, ...TenantMemberAuditActions, ...DocumentTypeAuditActions];

function actionResource(action: AdminAuditEvent["action"]): AdminAuditEvent["resourceType"] {
  if (action.startsWith("administrator.")) return "administrator";
  if (action.startsWith("tenant_member.")) return "tenant_member";
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
    if (error.code === "precondition_failed") return "资源信息已发生变化，请刷新后重试。";
    if (error.code === "bundle_already_exists") return "相同内容的 bundle 已经存在，请编辑现有候选项。";
    if (error.code === "bundle_invalid") return "ZIP 未通过 bundle 安全校验。";
    if (error.code === "operator_validation_failed") return "处理服务未通过 discovery 与签名探针验证。";
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
  const [activeTypeTab, setActiveTypeTab] = useState<DocumentTypeTab>(initialRoute.tab ?? "config");
  const [contracts, setContracts] = useState<readonly DocumentContractListItem[]>([]);
  const [contractCursor, setContractCursor] = useState<string | null>(null);
  const [selectedContract, setSelectedContract] = useState<DocumentContractRecord | null>(null);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [appendContractOpen, setAppendContractOpen] = useState(false);
  const [snapshotSchemaText, setSnapshotSchemaText] = useState('{\n  "$schema": "https://schemas.unidocs.dev/svalue/v1",\n  "type": "object"\n}');
  const [locationSchemaText, setLocationSchemaText] = useState('{\n  "$schema": "https://schemas.unidocs.dev/svalue/v1",\n  "type": "object"\n}');
  const [contractReason, setContractReason] = useState("");
  const [typeCardBundles, setTypeCardBundles] = useState<readonly TypeCardBundleListItem[]>([]);
  const [typeCardBundleCursor, setTypeCardBundleCursor] = useState<string | null>(null);
  const [selectedTypeCardBundle, setSelectedTypeCardBundle] = useState<TypeCardBundleRecord | null>(null);
  const [typeCardBundlesLoading, setTypeCardBundlesLoading] = useState(false);
  const [uploadTypeCardOpen, setUploadTypeCardOpen] = useState(false);
  const [editTypeCardOpen, setEditTypeCardOpen] = useState(false);
  const [typeCardFile, setTypeCardFile] = useState<File | null>(null);
  const [typeCardName, setTypeCardName] = useState("");
  const [typeCardDescription, setTypeCardDescription] = useState("");
  const [viewBundles, setViewBundles] = useState<readonly ViewBundleListItem[]>([]);
  const [viewBundleCursor, setViewBundleCursor] = useState<string | null>(null);
  const [selectedViewBundle, setSelectedViewBundle] = useState<ViewBundleRecord | null>(null);
  const [viewBundlesLoading, setViewBundlesLoading] = useState(false);
  const [uploadViewOpen, setUploadViewOpen] = useState(false);
  const [editViewOpen, setEditViewOpen] = useState(false);
  const [viewFile, setViewFile] = useState<File | null>(null);
  const [viewName, setViewName] = useState("");
  const [viewDescription, setViewDescription] = useState("");
  const [operatorBaseUrl, setOperatorBaseUrl] = useState("https://unidocs-markdown.shazhou.workers.dev");
  const [operatorExpectedConfigEtag, setOperatorExpectedConfigEtag] = useState("");
  const [operatorValidation, setOperatorValidation] = useState<OperatorValidation | null>(null);
  const [operatorValidationLoading, setOperatorValidationLoading] = useState(false);
  const [operatorValidationError, setOperatorValidationError] = useState<string | null>(null);
  const [addOperatorOpen, setAddOperatorOpen] = useState(false);
    const [operators, setOperators] = useState<readonly OperatorListItem[]>([]);
  const [operatorCursor, setOperatorCursor] = useState<string | null>(null);
  const [selectedOperator, setSelectedOperator] = useState<OperatorRecord | null>(null);
  const [operatorName, setOperatorName] = useState("Markdown Operator");
  const [operatorDescription, setOperatorDescription] = useState("");
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
  const [changeEvents, setChangeEvents] = useState<readonly AdminAuditEvent[]>([]);
  const [changeCursor, setChangeCursor] = useState<string | null>(null);
  const [selectedChange, setSelectedChange] = useState<AdminAuditEvent | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
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
    if (initialRoute.documentType) void openDetail(initialRoute.documentType, false, initialRoute.tab ?? "config");
    const handlePopState = () => applyRoute(parseAdminRoute(window.location.href));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  async function openDetail(documentType: string, updateRoute = true, tab: DocumentTypeTab = "config") {
    if (updateRoute) window.history.pushState({}, "", adminRoutePath({ view: "documentTypes", documentType, tab }));
    setActiveTypeTab(tab);
    setDetailLoading(true);
    setError(null);
    try {
      setSelected(await client.getDocumentType(documentType));
      if (tab === "contracts") await loadContracts(documentType);
      if (tab === "cards") await loadTypeCardBundles(documentType);
      if (tab === "bundles") await loadViewBundles(documentType);
      if (tab === "operators") await Promise.all([restoreOperatorValidation(documentType), loadOperators(documentType)]);
      if (tab === "changes") await loadChanges(documentType);
    }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setDetailLoading(false); }
  }

  async function loadContracts(documentType: string, cursor: string | null = null) {
    setContractsLoading(true);
    setError(null);
    try {
      const page = await client.listDocumentContracts(documentType, { limit: 25, cursor: cursor ?? undefined });
      startTransition(() => setContracts(current => cursor ? [...current, ...page.items] : page.items));
      setContractCursor(page.nextCursor);
      if (!cursor) setSelectedContract(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setContractsLoading(false);
    }
  }

  async function openContract(documentType: string, documentContractIdx: number) {
    setContractsLoading(true);
    setError(null);
    try { setSelectedContract(await client.getDocumentContract(documentType, documentContractIdx)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setContractsLoading(false); }
  }

  async function loadTypeCardBundles(documentType: string, cursor: string | null = null) {
    setTypeCardBundlesLoading(true);
    setError(null);
    try {
      const page = await client.listTypeCardBundles(documentType, { limit: 25, cursor: cursor ?? undefined });
      startTransition(() => setTypeCardBundles(current => cursor ? [...current, ...page.items] : page.items));
      setTypeCardBundleCursor(page.nextCursor);
      if (!cursor) setSelectedTypeCardBundle(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setTypeCardBundlesLoading(false);
    }
  }

  async function openTypeCardBundle(typeCardBundleId: string) {
    setTypeCardBundlesLoading(true);
    setError(null);
    try { setSelectedTypeCardBundle(await client.getTypeCardBundle(typeCardBundleId)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setTypeCardBundlesLoading(false); }
  }

  async function loadViewBundles(documentType: string, cursor: string | null = null) {
    setViewBundlesLoading(true);
    setError(null);
    try {
      const page = await client.listViewBundles(documentType, { limit: 25, cursor: cursor ?? undefined });
      startTransition(() => setViewBundles(current => cursor ? [...current, ...page.items] : page.items));
      setViewBundleCursor(page.nextCursor);
      if (!cursor) setSelectedViewBundle(null);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setViewBundlesLoading(false); }
  }

  async function openViewBundle(viewBundleId: string) {
    setViewBundlesLoading(true);
    setError(null);
    try { setSelectedViewBundle(await client.getViewBundle(viewBundleId)); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setViewBundlesLoading(false); }
  }

  async function restoreOperatorValidation(documentType: string) {
    setOperatorValidation(null);
    setOperatorValidationError(null);
    const validationId = sessionStorage.getItem(`unidocs.operator-validation.${documentType}`);
    if (!validationId) return;
    setOperatorValidationLoading(true);
    try { setOperatorValidation(await client.getOperatorValidation(validationId)); }
    catch {
      sessionStorage.removeItem(`unidocs.operator-validation.${documentType}`);
    } finally { setOperatorValidationLoading(false); }
  }

  async function loadOperators(documentType: string, cursor: string | null = null) {
    setOperatorValidationLoading(true);
    try { const page = await client.listOperators(documentType, { limit: 25, cursor: cursor ?? undefined }); setOperators(current => cursor ? [...current, ...page.items] : page.items); setOperatorCursor(page.nextCursor); }
    catch (caught) { setOperatorValidationError(errorMessage(caught)); }
    finally { setOperatorValidationLoading(false); }
  }

  async function openOperator(operatorId: string) { setOperatorValidationLoading(true); try { const record = await client.getOperator(operatorId); setSelectedOperator(record); setOperatorName(record.name); setOperatorDescription(record.description); } catch (caught) { setOperatorValidationError(errorMessage(caught)); } finally { setOperatorValidationLoading(false); } }

  function changeTypeTab(tab: DocumentTypeTab) {
    if (!selected) return;
    window.history.pushState({}, "", adminRoutePath({ view: "documentTypes", documentType: selected.documentType, tab }));
    setActiveTypeTab(tab);
    setSelectedContract(null);
    setSelectedTypeCardBundle(null);
    setSelectedViewBundle(null);
    setOperatorValidationError(null);
    if (tab === "contracts" && contracts.length === 0) void loadContracts(selected.documentType);
    if (tab === "cards" && typeCardBundles.length === 0) void loadTypeCardBundles(selected.documentType);
    if (tab === "bundles" && viewBundles.length === 0) void loadViewBundles(selected.documentType);
    if (tab === "operators") { void restoreOperatorValidation(selected.documentType); void loadOperators(selected.documentType); }
    if (tab === "changes" && changeEvents.length === 0) void loadChanges(selected.documentType);
  }

  async function uploadTypeCardBundle(event: FormEvent) {
    event.preventDefault();
    if (!selected || !typeCardFile || !typeCardName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await client.uploadTypeCardBundle(typeCardFile, { name: typeCardName.trim(), description: typeCardDescription });
      setUploadTypeCardOpen(false);
      setTypeCardFile(null);
      setTypeCardName("");
      setTypeCardDescription("");
      await loadTypeCardBundles(selected.documentType);
      await openTypeCardBundle(created.typeCardBundleId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSaving(false); }
  }

  function beginEditTypeCardBundle() {
    if (!selectedTypeCardBundle) return;
    setTypeCardName(selectedTypeCardBundle.name);
    setTypeCardDescription(selectedTypeCardBundle.description);
    setEditTypeCardOpen(true);
  }

  async function updateTypeCardBundleMetadata(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedTypeCardBundle || !typeCardName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await client.updateTypeCardBundleMetadata(selectedTypeCardBundle.typeCardBundleId, { name: typeCardName.trim(), description: typeCardDescription }, selectedTypeCardBundle.etag);
      setEditTypeCardOpen(false);
      await loadTypeCardBundles(selected.documentType);
      await openTypeCardBundle(selectedTypeCardBundle.typeCardBundleId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSaving(false); }
  }

  async function uploadViewBundle(event: FormEvent) {
    event.preventDefault();
    if (!selected || !viewFile || !viewName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await client.uploadViewBundle(viewFile, { name: viewName.trim(), description: viewDescription });
      setUploadViewOpen(false);
      setViewFile(null);
      setViewName("");
      setViewDescription("");
      await loadViewBundles(selected.documentType);
      await openViewBundle(created.viewBundleId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSaving(false); }
  }

  function beginEditViewBundle() {
    if (!selectedViewBundle) return;
    setViewName(selectedViewBundle.name);
    setViewDescription(selectedViewBundle.description);
    setEditViewOpen(true);
  }

  async function updateViewBundleMetadata(event: FormEvent) {
    event.preventDefault();
    if (!selected || !selectedViewBundle || !viewName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await client.updateViewBundleMetadata(selectedViewBundle.viewBundleId, { name: viewName.trim(), description: viewDescription }, selectedViewBundle.etag);
      setEditViewOpen(false);
      await loadViewBundles(selected.documentType);
      await openViewBundle(selectedViewBundle.viewBundleId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setSaving(false); }
  }

  async function validateOperator(event: FormEvent) {
    event.preventDefault();
    if (!selected || !operatorBaseUrl.trim()) return;
    setOperatorValidationLoading(true);
    setOperatorValidationError(null);
    setOperatorValidation(null);
    try {
      const validation = await client.createOperatorValidation({
        baseUrl: operatorBaseUrl.trim(),
        expectedDocumentType: selected.documentType,
        expectedConfigEtag: operatorExpectedConfigEtag.trim() || null,
      });
      sessionStorage.setItem(`unidocs.operator-validation.${selected.documentType}`, validation.validationId);
      setOperatorValidation(await client.getOperatorValidation(validation.validationId));
    } catch (caught) {
      setOperatorValidationError(errorMessage(caught));
    } finally { setOperatorValidationLoading(false); }
  }

  async function persistOperator() {
    if (!selected || !operatorValidation || !operatorName.trim()) return;
    setSaving(true); setOperatorValidationError(null);
    try { const created = await client.createOperator({ validationId: operatorValidation.validationId, name: operatorName.trim(), description: operatorDescription }); sessionStorage.removeItem(`unidocs.operator-validation.${selected.documentType}`); setOperatorValidation(null); setAddOperatorOpen(false); await loadOperators(selected.documentType); await openOperator(created.operatorId); }
    catch (caught) { setOperatorValidationError(errorMessage(caught)); } finally { setSaving(false); }
  }

  async function updateOperatorInfo() {
    if (!selected || !selectedOperator || !operatorName.trim()) return;
    setSaving(true); try { await client.updateOperatorMetadata(selectedOperator.operatorId, { name: operatorName.trim(), description: operatorDescription }, selectedOperator.etag); await loadOperators(selected.documentType); await openOperator(selectedOperator.operatorId); }
    catch (caught) { setOperatorValidationError(errorMessage(caught)); } finally { setSaving(false); }
  }

  async function updateRegistration(body: { typeCardBundleId?: string; viewBundleId?: string; builtinOperatorId?: string | null; enabled?: boolean }, reason: string) {
    if (!selected) return; setSaving(true); setError(null);
    try { await client.updateDocumentType(selected.documentType, { ...body, reason }, selected.etag); setSelected(await client.getDocumentType(selected.documentType)); await loadTypes(); }
    catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); }
  }

  async function appendContract(event: FormEvent) {
    event.preventDefault();
    if (!selected || !contractReason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const snapshotSchema = JSON.parse(snapshotSchemaText);
      const locationSchema = JSON.parse(locationSchemaText);
      await client.appendDocumentContract(selected.documentType, { formatVersion: 1, snapshot: { schema: snapshotSchema }, location: { schema: locationSchema }, reason: contractReason.trim() });
      setAppendContractOpen(false);
      setContractReason("");
      const refreshed = await client.getDocumentType(selected.documentType);
      setSelected(refreshed);
      await loadContracts(selected.documentType);
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "Schema 必须是有效 JSON。" : errorMessage(caught));
    } finally {
      setSaving(false);
    }
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

  async function loadChanges(documentType: string, cursor: string | null = null) {
    setChangesLoading(true);
    setError(null);
    try {
      const page = await client.listAuditEvents({ documentType, cursor: cursor ?? undefined, limit: 25 });
      startTransition(() => setChangeEvents(current => cursor ? [...current, ...page.items] : page.items));
      setChangeCursor(page.nextCursor);
      if (!cursor) setSelectedChange(null);
      if (members.length === 0) void loadMembers();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChangesLoading(false);
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
    setActiveTypeTab(route.tab ?? "config");
    if (route.view === "documentTypes" && route.documentType) void openDetail(route.documentType, false, route.tab ?? "config");
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

        <section className={`workspace ${selected ? "type-config-workspace" : ""}`}>
          {selected ? <div className="type-config">
            <div className="type-config-head"><div><button className="back-link" type="button" onClick={() => navigate({ view: "documentTypes" })}>文档类型</button><h2>{selected.internalName}</h2><code>{selected.documentType}</code></div><span className={`status ${selected.enabled ? "enabled" : "draft"}`}>{selected.enabled ? "已启用" : "草稿"}</span></div>
            <div className="type-tabs" role="tablist" aria-label="文档类型配置">{([
              ["config", "基本信息"], ["contracts", `文档契约 ${contracts.length || selected.latestDocumentContract ? (selected.latestDocumentContract?.documentContractIdx ?? -1) + 1 : 0}`],
                ["cards", "类型卡片包"], ["bundles", "界面包"], ["operators", `处理服务 ${operators.length}`], ["changes", "变更记录"],
            ] as const).map(([tab, label]) => <button key={tab} role="tab" aria-selected={activeTypeTab === tab} className={activeTypeTab === tab ? "active" : ""} type="button" onClick={() => changeTypeTab(tab)}>{label}</button>)}</div>
            <div className="type-config-body">
              <div className="type-config-main">
                {activeTypeTab === "config" && <section className="config-section"><div className="section-heading"><div><h3>基本信息</h3><p>启用前必须完成文档契约与三个运行资源。</p></div><button className={selected.enabled ? "secondary-button" : "primary-button"} type="button" disabled={saving} onClick={() => void updateRegistration({ enabled: !selected.enabled }, selected.enabled ? "Disable document type" : "Enable document type")}>{selected.enabled ? "停用" : "启用"}</button></div><dl className="detail-list"><div><dt>内部名称</dt><dd>{selected.internalName}</dd></div><div><dt>状态</dt><dd>{selected.enabled ? "已启用" : "草稿"}</dd></div><div><dt>ETag</dt><dd><code>{shortEtag(selected.etag)}</code></dd></div><div><dt>更新时间</dt><dd>{new Date(selected.updatedAt).toLocaleString("zh-CN")}</dd></div></dl></section>}
                {activeTypeTab === "contracts" && <section className="config-section"><div className="section-heading"><div><h3>文档契约</h3><p>不可变的 snapshot/location 配对 schema revision。</p></div><button className="primary-button" type="button" onClick={() => setAppendContractOpen(true)}><Plus size={16} />添加版本</button></div>
                  {contracts.map(contract => <button className={`contract-row ${selectedContract?.documentContractIdx === contract.documentContractIdx ? "active" : ""}`} type="button" key={contract.documentContractIdx} onClick={() => void openContract(selected.documentType, contract.documentContractIdx)}><span className="contract-idx">{contract.documentContractIdx}</span><span><strong>文档契约 {contract.documentContractIdx}</strong><code>{contract.contractHash}</code><small>{new Date(contract.createdAt).toLocaleString("zh-CN")} · format v{contract.formatVersion}</small></span><ChevronRight size={16} /></button>)}
                  {!contractsLoading && contracts.length === 0 && <div className="empty-state compact-empty"><ScrollText size={26} /><strong>尚未添加文档契约</strong><span>第一个版本将分配 revision 0。</span></div>}
                  {contractsLoading && contracts.length === 0 && <div className="empty-state compact-empty"><LoaderCircle className="spin" size={24} /><strong>正在读取文档契约</strong></div>}
                  {contractCursor && <div className="load-more"><button className="secondary-button" type="button" onClick={() => void loadContracts(selected.documentType, contractCursor)}>加载更多</button></div>}
                  {selectedContract && <div className="contract-detail"><h3>Revision {selectedContract.documentContractIdx}</h3><dl><div><dt>Contract hash</dt><dd><code>{selectedContract.contractHash}</code></dd></div><div><dt>Snapshot media type</dt><dd><code>{selectedContract.snapshot.contentType}</code></dd></div><div><dt>Snapshot hash</dt><dd><code>{selectedContract.snapshot.schemaHash}</code></dd></div><div><dt>Location media type</dt><dd><code>{selectedContract.location.contentType}</code></dd></div><div><dt>Location hash</dt><dd><code>{selectedContract.location.schemaHash}</code></dd></div></dl><div className="schema-grid"><div><strong>Snapshot schema</strong><pre>{JSON.stringify(selectedContract.snapshot.schema, null, 2)}</pre></div><div><strong>Location schema</strong><pre>{JSON.stringify(selectedContract.location.schema, null, 2)}</pre></div></div></div>}
                </section>}
                {activeTypeTab === "cards" && <section className="config-section"><div className="section-heading"><div><h3>类型卡片包候选项</h3><p>每个不可变版本包含多语言文案、图标与样例缩略图。</p></div><button className="primary-button" type="button" onClick={() => setUploadTypeCardOpen(true)}><UploadCloud size={16} />上传候选项</button></div>
                  <div className="bundle-history">{typeCardBundles.map(bundle => <button className={`bundle-row ${selectedTypeCardBundle?.typeCardBundleId === bundle.typeCardBundleId ? "active" : ""}`} type="button" key={bundle.typeCardBundleId} onClick={() => void openTypeCardBundle(bundle.typeCardBundleId)}><span className="bundle-mark"><LayoutTemplate size={17} /></span><span><strong>{bundle.name}</strong><code>{bundle.typeCardBundleId}</code><small>{new Date(bundle.uploadedAt).toLocaleString("zh-CN")} · {Math.max(1, Math.ceil(bundle.size / 1024))} KB</small></span><ChevronRight size={16} /></button>)}</div>
                  {!typeCardBundlesLoading && typeCardBundles.length === 0 && <div className="empty-state compact-empty"><LayoutTemplate size={26} /><strong>尚未上传类型卡片包</strong><span>上传 ZIP 后会先校验 manifest 与全部图片资源。</span></div>}
                  {typeCardBundlesLoading && typeCardBundles.length === 0 && <div className="empty-state compact-empty"><LoaderCircle className="spin" size={24} /><strong>正在读取类型卡片包</strong></div>}
                  {typeCardBundleCursor && <div className="load-more"><button className="secondary-button" type="button" onClick={() => void loadTypeCardBundles(selected.documentType, typeCardBundleCursor)}>加载更多</button></div>}
                  {selectedTypeCardBundle && <div className="load-more"><button className="primary-button" type="button" disabled={saving || selected.typeCardBundle?.typeCardBundleId === selectedTypeCardBundle.typeCardBundleId} onClick={() => void updateRegistration({ typeCardBundleId: selectedTypeCardBundle.typeCardBundleId }, "Select Type Card bundle")}>{selected.typeCardBundle?.typeCardBundleId === selectedTypeCardBundle.typeCardBundleId ? "当前卡片包" : "绑定所选卡片包"}</button></div>}
                  {selectedTypeCardBundle && <div className="bundle-detail"><div className="bundle-detail-heading"><div><span>VALIDATED CANDIDATE</span><h3>{selectedTypeCardBundle.name}</h3><p>{selectedTypeCardBundle.description || "没有管理员备注"}</p></div><button className="secondary-button" type="button" onClick={beginEditTypeCardBundle}><Pencil size={15} />编辑信息</button></div><div className="type-card-preview"><img src={new URL(selectedTypeCardBundle.manifest.sampleThumbnail, selectedTypeCardBundle.bundleUrl).href} alt={selectedTypeCardBundle.manifest.locales.en.sampleThumbnailAlt} /><div><span className="preview-icon"><img src={new URL(selectedTypeCardBundle.manifest.icon.kind === "svg" ? selectedTypeCardBundle.manifest.icon.path : selectedTypeCardBundle.manifest.icon.images[128], selectedTypeCardBundle.bundleUrl).href} alt="" /></span><strong>{selectedTypeCardBundle.manifest.locales.en.name}</strong><p>{selectedTypeCardBundle.manifest.locales.en.description}</p></div></div><dl><div><dt>Bundle ID</dt><dd><code>{selectedTypeCardBundle.typeCardBundleId}</code></dd></div><div><dt>Manifest protocol</dt><dd><code>{selectedTypeCardBundle.manifest.protocol}</code></dd></div><div><dt>可用语言</dt><dd className="locale-list"><Languages size={14} />{Object.keys(selectedTypeCardBundle.manifest.locales).join(" · ")}</dd></div><div><dt>Icon</dt><dd><code>{selectedTypeCardBundle.manifest.icon.kind === "svg" ? selectedTypeCardBundle.manifest.icon.path : Object.values(selectedTypeCardBundle.manifest.icon.images).join(", ")}</code></dd></div><div><dt>Sample thumbnail</dt><dd><code>{selectedTypeCardBundle.manifest.sampleThumbnail}</code></dd></div><div><dt>Bundle URL</dt><dd><a href={selectedTypeCardBundle.bundleUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{selectedTypeCardBundle.bundleUrl}</a></dd></div><div><dt>ETag</dt><dd><code>{shortEtag(selectedTypeCardBundle.etag)}</code></dd></div></dl></div>}
                </section>}
                {activeTypeTab === "bundles" && <section className="config-section"><div className="section-heading"><div><h3>界面包候选项</h3><p>每个不可变版本包含隔离运行的交互与缩略图入口。</p></div><button className="primary-button" type="button" onClick={() => setUploadViewOpen(true)}><UploadCloud size={16} />上传候选项</button></div>
                  <div className="bundle-history">{viewBundles.map(bundle => <button className={`bundle-row ${selectedViewBundle?.viewBundleId === bundle.viewBundleId ? "active" : ""}`} type="button" key={bundle.viewBundleId} onClick={() => void openViewBundle(bundle.viewBundleId)}><span className="bundle-mark"><LayoutTemplate size={17} /></span><span><strong>{bundle.name}</strong><code>{bundle.viewBundleId}</code><small>revisions {bundle.supportedDocumentContractIdxs.join(" · ")} · {Math.max(1, Math.ceil(bundle.size / 1024))} KB</small></span><ChevronRight size={16} /></button>)}</div>
                  {!viewBundlesLoading && viewBundles.length === 0 && <div className="empty-state compact-empty"><LayoutTemplate size={26} /><strong>尚未上传界面包</strong><span>上传 ZIP 后会校验双入口、revision 与全部静态资源。</span></div>}
                  {viewBundlesLoading && viewBundles.length === 0 && <div className="empty-state compact-empty"><LoaderCircle className="spin" size={24} /><strong>正在读取界面包</strong></div>}
                  {viewBundleCursor && <div className="load-more"><button className="secondary-button" type="button" onClick={() => void loadViewBundles(selected.documentType, viewBundleCursor)}>加载更多</button></div>}
                  {selectedViewBundle && <div className="load-more"><button className="primary-button" type="button" disabled={saving || selected.viewBundle?.viewBundleId === selectedViewBundle.viewBundleId} onClick={() => void updateRegistration({ viewBundleId: selectedViewBundle.viewBundleId }, "Select View bundle")}>{selected.viewBundle?.viewBundleId === selectedViewBundle.viewBundleId ? "当前界面包" : "绑定所选界面包"}</button></div>}
                  {selectedViewBundle && <div className="bundle-detail"><div className="bundle-detail-heading"><div><span>VALIDATED CANDIDATE</span><h3>{selectedViewBundle.name}</h3><p>{selectedViewBundle.description || "没有管理员备注"}</p></div><button className="secondary-button" type="button" onClick={beginEditViewBundle}><Pencil size={15} />编辑信息</button></div><dl><div><dt>Bundle ID</dt><dd><code>{selectedViewBundle.viewBundleId}</code></dd></div><div><dt>Manifest protocol</dt><dd><code>{selectedViewBundle.manifest.protocol}</code></dd></div><div><dt>支持 revisions</dt><dd>{selectedViewBundle.manifest.supportedDocumentContractIdxs.map(idx => `revision ${idx}`).join(" · ")}</dd></div><div><dt>交互入口</dt><dd><a href={new URL(selectedViewBundle.manifest.entrypoints.interactive, selectedViewBundle.bundleUrl).href} target="_blank" rel="noreferrer"><ExternalLink size={13} />{selectedViewBundle.manifest.entrypoints.interactive}</a></dd></div><div><dt>缩略图入口</dt><dd><a href={new URL(selectedViewBundle.manifest.entrypoints.thumbnail, selectedViewBundle.bundleUrl).href} target="_blank" rel="noreferrer"><ExternalLink size={13} />{selectedViewBundle.manifest.entrypoints.thumbnail}</a></dd></div><div><dt>Bundle URL</dt><dd><a href={selectedViewBundle.bundleUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{selectedViewBundle.bundleUrl}</a></dd></div><div><dt>ETag</dt><dd><code>{shortEtag(selectedViewBundle.etag)}</code></dd></div></dl></div>}
                </section>}
                {activeTypeTab === "operators" && <section className="config-section"><div className="section-heading"><div><h3>操作代理</h3><p>可配置多个候选项；同时只能有一个当前处理服务。</p></div><button className="primary-button" type="button" onClick={() => { setAddOperatorOpen(true); setOperatorValidationError(null); }}><Plus size={16} />添加操作代理</button></div>
                  {addOperatorOpen && <form className="operator-validation-form operator-add-panel" onSubmit={validateOperator}>
                    <label><span>服务 URL</span><input aria-label="处理服务 URL" type="url" required value={operatorBaseUrl} onChange={event => setOperatorBaseUrl(event.target.value)} /></label>
                    <label><span>文档类型</span><input aria-label="验证文档类型" readOnly value={selected.documentType} /></label>
                    <label><span>预期配置 ETag（可选）</span><input aria-label="预期配置 ETag" value={operatorExpectedConfigEtag} onChange={event => setOperatorExpectedConfigEtag(event.target.value)} placeholder={'例如："sha256-..."'} /></label>
                    <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => { setAddOperatorOpen(false); setOperatorValidation(null); setOperatorValidationError(null); }}>取消</button><button className="primary-button" type="submit" disabled={operatorValidationLoading || !operatorBaseUrl.trim()}>{operatorValidationLoading ? <LoaderCircle className="spin" size={16} /> : <ShieldAlert size={16} />}验证处理服务</button></div>
                  </form>}
                  {addOperatorOpen && operatorValidationError && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{operatorValidationError}</span><button type="button" onClick={() => setOperatorValidationError(null)} aria-label="关闭验证错误"><X size={16} /></button></div>}
                  {addOperatorOpen && operatorValidationLoading && !operatorValidation && <div className="empty-state compact-empty" role="status"><LoaderCircle className="spin" size={24} /><strong>正在验证处理服务</strong></div>}
                  {addOperatorOpen && !operatorValidationLoading && !operatorValidation && !operatorValidationError && <div className="empty-state compact-empty"><ShieldAlert size={26} /><strong>等待验证</strong><span>验证通过后登记为新的候选项，不会自动切换当前服务。</span></div>}
                  {operatorValidation && <div className="bundle-detail"><div className="bundle-detail-heading"><div><span>VALIDATION PASSED</span><h3>{operatorValidation.descriptor.displayName}</h3><p>此验证将在 {new Date(operatorValidation.expiresAt).toLocaleString("zh-CN")} 过期。</p></div><span className="status enabled"><Check size={13} />已验证</span></div><dl><div><dt>Validation ID</dt><dd><code>{operatorValidation.validationId}</code></dd></div><div><dt>Declared Operator ID</dt><dd><code>{operatorValidation.descriptor.declaredOperatorId}</code></dd></div><div><dt>协议</dt><dd><code>{operatorValidation.descriptor.protocol}</code></dd></div><div><dt>Base URL</dt><dd><a href={operatorValidation.baseUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />{operatorValidation.baseUrl}</a></dd></div><div><dt>Config ETag</dt><dd><code>{operatorValidation.expectedConfigEtag ?? "未固定"}</code></dd></div><div><dt>支持 revisions</dt><dd>{operatorValidation.descriptor.supportedDocumentContracts[selected.documentType]?.map(idx => `revision ${idx}`).join(" · ") ?? "无"}</dd></div></dl><div className="operator-validation-form"><label><span>候选项名称</span><input aria-label="处理服务候选项名称" value={operatorName} onChange={event => setOperatorName(event.target.value)} /></label><label><span>管理员备注</span><textarea className="metadata-textarea" value={operatorDescription} onChange={event => setOperatorDescription(event.target.value)} /></label><div className="modal-actions"><button className="primary-button" type="button" disabled={saving || !operatorName.trim()} onClick={() => void persistOperator()}><Plus size={16} />保存处理服务</button></div></div></div>}
                  <div className="operator-history">{operators.map(operator => { const current = selected.builtinOperator?.operatorId === operator.operatorId; return <article className={`operator-candidate ${current ? "active" : ""}`} key={operator.operatorId}><span className="operator-mark"><ShieldAlert size={18} /></span><div className="operator-summary"><div className="candidate-title"><strong>{operator.name}</strong>{current && <span className="status enabled"><Check size={13} />当前</span>}</div><p>{operator.description || "未填写描述"}</p><code>{operator.operatorId}</code><div className="candidate-meta"><span>{operator.baseUrl}</span><span>contract {operator.supportedDocumentContractIdxs.join(", ")}</span><span>验证通过</span></div></div><div className="candidate-actions">{current ? <span className="status enabled">正在使用</span> : <button className="secondary-button" type="button" disabled={saving} onClick={() => void updateRegistration({ builtinOperatorId: operator.operatorId }, "Select builtin Operator")}><Check size={15} />设为当前</button>}<button className="icon-button bordered" type="button" onClick={() => void openOperator(operator.operatorId)} title="编辑名称与描述" aria-label={`编辑 ${operator.name}`}><Pencil size={15} /></button></div></article>; })}</div>
                  {operatorCursor && <div className="load-more"><button className="secondary-button" type="button" onClick={() => void loadOperators(selected.documentType, operatorCursor)}>加载更多</button></div>}
                  {selectedOperator && <div className="bundle-detail"><div className="bundle-detail-heading"><div><span>PERSISTENT CANDIDATE</span><h3>{selectedOperator.name}</h3><p>{selectedOperator.description || "没有管理员备注"}</p></div><span className={`status ${selected.builtinOperator?.operatorId === selectedOperator.operatorId ? "enabled" : "draft"}`}>{selected.builtinOperator?.operatorId === selectedOperator.operatorId ? "当前绑定" : "候选项"}</span></div><dl><div><dt>Operator ID</dt><dd><code>{selectedOperator.operatorId}</code></dd></div><div><dt>Declared ID</dt><dd><code>{selectedOperator.descriptor.declaredOperatorId}</code></dd></div><div><dt>Base URL</dt><dd><a href={selectedOperator.baseUrl} target="_blank" rel="noreferrer">{selectedOperator.baseUrl}</a></dd></div><div><dt>支持 revisions</dt><dd>{selectedOperator.descriptor.supportedDocumentContracts[selected.documentType]?.map(idx => `revision ${idx}`).join(" · ")}</dd></div></dl><div className="operator-validation-form"><label><span>候选项名称</span><input aria-label="编辑处理服务名称" value={operatorName} onChange={event => setOperatorName(event.target.value)} /></label><label><span>管理员备注</span><textarea className="metadata-textarea" value={operatorDescription} onChange={event => setOperatorDescription(event.target.value)} /></label><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => void updateOperatorInfo()}><Pencil size={15} />保存信息</button><button className="primary-button" type="button" disabled={saving} onClick={() => void updateRegistration({ builtinOperatorId: selected.builtinOperator?.operatorId === selectedOperator.operatorId ? null : selectedOperator.operatorId }, selected.builtinOperator?.operatorId === selectedOperator.operatorId ? "Clear builtin Operator" : "Select builtin Operator")}>{selected.builtinOperator?.operatorId === selectedOperator.operatorId ? "解除绑定" : "绑定为当前服务"}</button></div></div></div>}
                </section>}
                {activeTypeTab === "changes" && <section className="config-section"><div className="section-heading"><div><h3>变更记录</h3><p>当前文档类型的配置、候选资源与验证事件，按时间倒序排列。</p></div><button className="icon-button bordered" type="button" onClick={() => void loadChanges(selected.documentType)} title="刷新变更记录" aria-label="刷新变更记录"><RefreshCw className={changesLoading ? "spin" : ""} size={17} /></button></div>
                  <div className="change-history">{changeEvents.map(event => <button className={`change-row ${selectedChange?.auditEventId === event.auditEventId ? "active" : ""}`} type="button" key={event.auditEventId} onClick={() => setSelectedChange(event)}><span className="change-marker"><ScrollText size={16} /></span><span className="change-summary"><strong>{auditActionLabel(event.action)}</strong><small>{resourceLabels[event.resourceType]} · {event.resourceId}</small><span>{event.reason || "无变更备注"}</span></span><span className="change-meta"><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time><small>{actorIdentity(event.actorId)?.email ?? event.actorId}</small></span><ChevronRight size={16} /></button>)}</div>
                  {!changesLoading && changeEvents.length === 0 && <div className="empty-state compact-empty"><ScrollText size={26} /><strong>还没有变更记录</strong><span>此文档类型的配置操作会在这里留下不可变审计事件。</span></div>}
                  {changesLoading && changeEvents.length === 0 && <div className="empty-state compact-empty" role="status"><LoaderCircle className="spin" size={24} /><strong>正在读取变更记录</strong></div>}
                  {changeCursor && <div className="load-more"><button className="secondary-button" type="button" disabled={changesLoading} onClick={() => void loadChanges(selected.documentType, changeCursor)}>{changesLoading ? <LoaderCircle className="spin" size={15} /> : null}加载更多</button></div>}
                  {selectedChange && <div className="change-detail"><div className="bundle-detail-heading"><div><span>AUDIT EVENT</span><h3>{auditActionLabel(selectedChange.action)}</h3><p>{new Date(selectedChange.occurredAt).toLocaleString("zh-CN")}</p></div><button className="icon-button bordered" type="button" onClick={() => setSelectedChange(null)} aria-label="关闭变更详情"><X size={16} /></button></div><dl><div><dt>Event ID</dt><dd><code>{selectedChange.auditEventId}</code></dd></div><div><dt>Request ID</dt><dd><code>{selectedChange.requestId}</code></dd></div><div><dt>操作者</dt><dd>{actorIdentity(selectedChange.actorId) ? <><strong>{actorIdentity(selectedChange.actorId)!.name}</strong><small>{actorIdentity(selectedChange.actorId)!.email}</small><code>{selectedChange.actorId}</code></> : <code>{selectedChange.actorId}</code>}</dd></div><div><dt>资源</dt><dd><code>{selectedChange.resourceType}/{selectedChange.resourceId}</code></dd></div><div><dt>原因</dt><dd>{selectedChange.reason ?? "—"}</dd></div></dl>{selectedChange.details !== undefined && <div className="audit-details-json"><strong>结构化详情</strong><pre>{JSON.stringify(selectedChange.details, null, 2)}</pre></div>}</div>}
                </section>}
              </div>
              <aside className="config-aside"><h3>启用准备度</h3><dl><div><dt>文档契约</dt><dd>{selected.latestDocumentContract ? `revision ${selected.latestDocumentContract.documentContractIdx}` : "缺失"}</dd></div><div><dt>类型卡片包</dt><dd>{selected.typeCardBundle?.name ?? "缺失"}</dd></div><div><dt>视图包</dt><dd>{selected.viewBundle?.name ?? "缺失"}</dd></div><div><dt>处理服务</dt><dd>{selected.builtinOperator?.name ?? "缺失"}</dd></div></dl></aside>
            </div>
          </div> : <>
            <div className="table-region">
              <div className="table-meta"><span>{loading ? "正在同步" : `${items.length} 个类型`}</span><span>最多显示 50 项</span></div>
              <div className="table-scroll">
                <table><thead><tr><th>文档类型</th><th>状态</th><th>Contract</th><th>资源</th><th><span className="sr-only">详情</span></th></tr></thead>
                  <tbody>{items.map(item => <tr key={item.documentType} onClick={() => void openDetail(item.documentType)}>
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

          </>}
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
    {appendContractOpen && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setAppendContractOpen(false); }}>
      <section className="modal contract-modal" role="dialog" aria-modal="true" aria-labelledby="append-contract-title"><div className="modal-header"><div><span>APPEND IMMUTABLE REVISION</span><h2 id="append-contract-title">添加文档契约</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setAppendContractOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={appendContract}><div className="schema-input-grid"><label><span>Snapshot schema</span><textarea aria-label="Snapshot schema" value={snapshotSchemaText} onChange={event => setSnapshotSchemaText(event.target.value)} /></label><label><span>Location schema</span><textarea aria-label="Location schema" value={locationSchemaText} onChange={event => setLocationSchemaText(event.target.value)} /></label></div><label><span>变更原因</span><input required value={contractReason} onChange={event => setContractReason(event.target.value)} placeholder="说明新增 revision 的原因" /></label><p>提交后不可修改或删除；revision 从 0 连续分配。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setAppendContractOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !contractReason.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}提交版本</button></div></form>
      </section>
    </div>}
    {uploadTypeCardOpen && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setUploadTypeCardOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-card-title"><div className="modal-header"><div><span>VALIDATE IMMUTABLE BUNDLE</span><h2 id="upload-card-title">上传类型卡片包</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setUploadTypeCardOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={uploadTypeCardBundle}><label><span>候选项名称</span><input autoFocus maxLength={256} value={typeCardName} onChange={event => setTypeCardName(event.target.value)} placeholder="例如：Markdown 主卡片" /></label><label><span>管理员备注</span><textarea className="metadata-textarea" maxLength={2048} value={typeCardDescription} onChange={event => setTypeCardDescription(event.target.value)} placeholder="仅供管理员识别，不进入 manifest" /></label><label className="file-control"><span>类型卡片包 ZIP</span><input aria-label="类型卡片包 ZIP" type="file" accept=".zip,application/zip" onChange={event => setTypeCardFile(event.target.files?.[0] ?? null)} /></label><p>服务端将验证 canonical manifest、路径闭包、图片格式与尺寸；成功后内容不可修改。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setUploadTypeCardOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !typeCardName.trim() || !typeCardFile}>{saving ? <LoaderCircle className="spin" size={16} /> : <UploadCloud size={16} />}上传并验证</button></div></form>
      </section>
    </div>}
    {editTypeCardOpen && selectedTypeCardBundle && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditTypeCardOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-card-title"><div className="modal-header"><div><span>ADMIN METADATA</span><h2 id="edit-card-title">编辑候选项信息</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setEditTypeCardOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={updateTypeCardBundleMetadata}><label><span>候选项名称</span><input autoFocus maxLength={256} value={typeCardName} onChange={event => setTypeCardName(event.target.value)} /></label><label><span>管理员备注</span><textarea className="metadata-textarea" maxLength={2048} value={typeCardDescription} onChange={event => setTypeCardDescription(event.target.value)} /></label><p>只更新管理员 metadata；bundle 内容、URL 与 manifest 保持不变。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setEditTypeCardOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !typeCardName.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Pencil size={16} />}保存信息</button></div></form>
      </section>
    </div>}
    {uploadViewOpen && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setUploadViewOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-view-title"><div className="modal-header"><div><span>VALIDATE IMMUTABLE BUNDLE</span><h2 id="upload-view-title">上传界面包</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setUploadViewOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={uploadViewBundle}><label><span>候选项名称</span><input autoFocus maxLength={256} value={viewName} onChange={event => setViewName(event.target.value)} placeholder="例如：Markdown 主界面" /></label><label><span>管理员备注</span><textarea className="metadata-textarea" maxLength={2048} value={viewDescription} onChange={event => setViewDescription(event.target.value)} placeholder="仅供管理员识别，不进入 manifest" /></label><label className="file-control"><span>界面包 ZIP</span><input aria-label="界面包 ZIP" type="file" accept=".zip,application/zip" onChange={event => setViewFile(event.target.files?.[0] ?? null)} /></label><p>服务端将验证双 HTML 入口、已登记 revisions 与静态资源 allowlist；成功后内容不可修改。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setUploadViewOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !viewName.trim() || !viewFile}>{saving ? <LoaderCircle className="spin" size={16} /> : <UploadCloud size={16} />}上传并验证</button></div></form>
      </section>
    </div>}
    {editViewOpen && selectedViewBundle && <div className="modal-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setEditViewOpen(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-view-title"><div className="modal-header"><div><span>ADMIN METADATA</span><h2 id="edit-view-title">编辑界面包信息</h2></div><button className="icon-button" type="button" disabled={saving} onClick={() => setEditViewOpen(false)} aria-label="关闭"><X size={18} /></button></div>
        <form onSubmit={updateViewBundleMetadata}><label><span>候选项名称</span><input autoFocus maxLength={256} value={viewName} onChange={event => setViewName(event.target.value)} /></label><label><span>管理员备注</span><textarea className="metadata-textarea" maxLength={2048} value={viewDescription} onChange={event => setViewDescription(event.target.value)} /></label><p>只更新管理员 metadata；bundle 内容、入口、URL 与 revisions 保持不变。</p><div className="modal-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => setEditViewOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={saving || !viewName.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Pencil size={16} />}保存信息</button></div></form>
      </section>
    </div>}
  </div>;
}

export function App() {
  if (window.location.pathname === "/admin/login") return <LoginPrompt />;
  if (window.location.pathname === "/admin/access-denied") return <AccessDenied />;
  return <AdminApp />;
}