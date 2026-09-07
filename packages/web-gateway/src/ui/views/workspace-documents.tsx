import { Download, Eye, FileText, Layers, LogOut, Monitor, Plus, RefreshCw, Search, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, createDocument, downloadDocument, listDocuments, validateImportFile, type GatewayDocumentRecord } from "../api.js";
import type { OAuthTokenSession } from "../oauth.js";
import { DEFAULT_DOC_TYPES } from "../config.js";
import logo from "../studio/logo.svg";
import { CreationStatus } from "./creation-status.js";
import { creationTrackingScope, readCreationTracking, writeCreationTracking, type PendingCreation } from "../creation-tracking.js";
import "./documents.css";

export interface DocumentsViewProps { readonly session: OAuthTokenSession; readonly onSignedOut: () => void; }
const types = [...new Set(DEFAULT_DOC_TYPES)];
const typeName = (type: string) => type === "markdown" ? "Markdown" : type.toUpperCase();
const typeClass = (type: string) => type === "psd" ? "type-psd" : type === "markdown" ? "type-md" : "type-other";
const canPreview = (type: string) => type === "markdown" || type === "psd";
const timestamp = (value: string | number) => { const result = new Date(value).getTime(); return Number.isFinite(result) ? result : 0; };
const dateLabel = (value: string | number) => timestamp(value) ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "时间未知";
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const previewLink = (doc: GatewayDocumentRecord) => `#/preview/${encodeURIComponent(doc.doc_type)}/${encodeURIComponent(doc.doc_id)}`;

export function DocumentsView({ session, onSignedOut }: DocumentsViewProps) {
  const [documents, setDocuments] = useState<GatewayDocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [failedTypes, setFailedTypes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState("updated");
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState(types[0] ?? "");
  const [createMode, setCreateMode] = useState<"blank" | "import">("blank");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [createdLink, setCreatedLink] = useState("");
  const trackingScope = creationTrackingScope(session);
  const [restoredTracking] = useState(() => {
    try { return { items: readCreationTracking(trackingScope), error: "" }; }
    catch (reason) { return { items: [] as PendingCreation[], error: messageOf(reason) }; }
  });
  const [pendingCreations, setPendingCreations] = useState<PendingCreation[]>(restoredTracking.items);
  const trackingItems = useRef(restoredTracking.items);
  const [trackingError, setTrackingError] = useState(restoredTracking.error);
  const [retryImport, setRetryImport] = useState(false);
  const importId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const busyCreate = useRef(false);
  const active = useRef(true);
  const signOut = useRef(onSignedOut); signOut.current = onSignedOut;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (createOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [createOpen]);
  useEffect(() => {
    const controller = new AbortController();
    if (window.matchMedia?.("(max-width: 760px)").matches) { setLoading(false); return; }
    setLoading(true); setError(""); setDocuments([]); setFailedTypes([]);
    Promise.allSettled(types.map(type => listDocuments(session.tenantId, type, controller.signal))).then(results => {
      if (controller.signal.aborted) return;
      if (results.some(result => result.status === "rejected" && result.reason instanceof ApiError && result.reason.status === 401)) { signOut.current(); return; }
      const failed: string[] = []; const records = new Map<string, GatewayDocumentRecord>();
      results.forEach((result, index) => {
        if (result.status === "rejected") { failed.push(types[index]!); return; }
        result.value.filter(doc => doc.doc_type === types[index]).forEach(doc => records.set(`${doc.doc_type}:${doc.doc_id}`, doc));
      });
      setDocuments([...records.values()]); setFailedTypes(failed); setLoading(false);
    });
    return () => controller.abort();
  }, [session.tenantId, reload]);

  function closeCreate() { if (!busyCreate.current) { setCreateOpen(false); createButton.current?.focus(); } }
  function persistTracking(items: PendingCreation[]) {
    trackingItems.current = items;
    try { writeCreationTracking(trackingScope, items); setTrackingError(""); }
    catch (reason) { setTrackingError(messageOf(reason)); }
  }
  function trackCreation(item: PendingCreation) {
    if (trackingItems.current.some(record => record.docType === item.docType && record.docId === item.docId)) return;
    const items = [...trackingItems.current, item];
    setPendingCreations(previous => [...previous.filter(record => record.docType !== item.docType || record.docId !== item.docId), item]);
    persistTracking(items);
  }
  function finishTracking(item: PendingCreation) {
    persistTracking(trackingItems.current.filter(record => record.docType !== item.docType || record.docId !== item.docId));
  }
  function clearImport() {
    setImportFile(null); setImportError(""); setRetryImport(false); importId.current = null;
    if (fileInput.current) fileInput.current.value = "";
  }
  function selectFile(file: File | undefined) {
    clearImport();
    if (!file) return;
    try { validateImportFile(createType, file); setImportFile(file); importId.current = crypto.randomUUID(); }
    catch (reason) { setImportError(messageOf(reason)); }
  }
  async function create() {
    if (busyCreate.current || !types.includes(createType)) return;
    if (createMode === "import" && (!importFile || !importId.current)) { setImportError("请先选择文件"); return; }
    busyCreate.current = true; setCreating(true); setError(""); setNotice(""); setImportError(""); setCreatedLink("");
    try {
      const result = createMode === "import"
        ? await createDocument(session.tenantId, createType, { file: importFile!, requestId: importId.current! })
        : await createDocument(session.tenantId, createType);
      if (!active.current) return;
      if (!result.docId) throw new Error("创建响应缺少作品标识");
      setCreateOpen(false);
      setNotice(result.state === "creating" ? `正在创建 ${typeName(createType)} · ${result.docId}，可检查创建状态。`
        : `已创建 ${typeName(createType)} · ${result.docId}${result.version ? ` · v${result.version}` : ""}`);
      if (result.state === "creating") trackCreation({ docType: createType, docId: result.docId });
      if (result.state !== "creating" && canPreview(createType)) setCreatedLink(`#/preview/${encodeURIComponent(createType)}/${encodeURIComponent(result.docId)}`);
      clearImport();
      setReload(value => value + 1);
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof ApiError && reason.status === 401) signOut.current();
      else if (createMode === "import") {
        const rejectedFile = reason instanceof ApiError && [400, 413, 415, 422].includes(reason.status);
        if (rejectedFile) {
          clearImport();
          setImportError(`${messageOf(reason)}。文件被拒绝，请重新选择文件。`);
        } else {
          setRetryImport(true);
          setImportError(`${messageOf(reason)}。保留文件和请求标识；重试会沿用本次创建请求。`);
        }
      } else { setError(messageOf(reason)); setCreateOpen(false); }
    } finally { busyCreate.current = false; if (active.current) { setCreating(false); createButton.current?.focus(); } }
  }

  async function exportDocument(doc: GatewayDocumentRecord) {
    if (exporting) return;
    setExporting(`${doc.doc_type}:${doc.doc_id}`); setError("");
    try { await downloadDocument(session.tenantId, doc.doc_type, doc.doc_id, `${doc.doc_id}.${doc.doc_type === "markdown" ? "md" : doc.doc_type}`); }
    catch (reason) { if (active.current) setError(messageOf(reason)); }
    finally { if (active.current) setExporting(null); }
  }

  const filtered = documents.filter(doc => (!typeFilter || doc.doc_type === typeFilter) && doc.doc_id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => sort === "id" ? left.doc_id.localeCompare(right.doc_id)
      : timestamp(sort === "created" ? right.created_at : right.updated_at) - timestamp(sort === "created" ? left.created_at : left.updated_at) || left.doc_id.localeCompare(right.doc_id));

  return <div className="workspace-ui">
    <section className="workspace-mobile"><img src={logo} alt="UniDocs" /><Monitor /><h1>请在电脑或平板上查看</h1></section>
    <div className="workspace-desktop">
      <aside className="workspace-sidebar"><a href="#/documents" className="workspace-brand"><img src={logo} alt="" />UniDocs</a><p className="workspace-caption">个人工作空间</p><div className="workspace-nav"><Layers size={16} />我的作品<span>{documents.length}</span></div><a className="workspace-local" href="#/">本地试验</a><div className="workspace-account"><span>已登录</span><small>tenant: {session.tenantId}</small><button onClick={onSignedOut}><LogOut size={14} />退出登录</button></div></aside>
      <main className="workspace-main"><header className="workspace-top"><span>工作空间 / 我的作品</span><span>云端</span></header>
        <section className="workspace-content"><div className="workspace-intro"><div><div className="workspace-eyebrow">WORKSPACE</div><h1>我的作品</h1><p>{loading ? "读取作品目录…" : `${documents.length} 件已加载作品`}</p></div><button className="workspace-primary" ref={createButton} disabled={!types.length || creating} onClick={() => setCreateOpen(true)}><Plus size={16} />新建作品</button></div>
          <div className="workspace-filters"><label className="workspace-search"><Search size={15} /><input aria-label="搜索作品 ID" placeholder="搜索作品 ID…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="按类型筛选" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="">所有类型</option>{types.map(type => <option key={type} value={type}>{typeName(type)}</option>)}</select><select aria-label="作品排序" value={sort} onChange={event => setSort(event.target.value)}><option value="updated">最近更新</option><option value="created">最近创建</option><option value="id">作品 ID</option></select><span className="workspace-grow" /><button aria-label="刷新作品列表" title="刷新作品列表" disabled={loading || creating} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} /></button></div>
          {notice && <p className="workspace-notice" role="status">{notice}{createdLink && <a className="workspace-created-link" href={createdLink}><Eye size={14} />打开预览</a>}</p>}
          {error && <p className="workspace-error" role="alert">{error}</p>}
          {trackingError && <div className="workspace-error" role="alert">创建跟踪尚未保存：{trackingError}。本次创建不会因此重新提交，刷新可能丢失检查入口。<button onClick={() => persistTracking(trackingItems.current)}>重试保存跟踪</button></div>}
          {pendingCreations.length > 0 && <p className="workspace-tracking-note">待完成创建在本标签页内保留，刷新可恢复；退出登录会清除本地跟踪，不取消服务端创建。</p>}
          {pendingCreations.map(item => <CreationStatus key={`${trackingScope}:${item.docType}:${item.docId}`} tenantId={session.tenantId} {...item} onReady={() => { finishTracking(item); setNotice(""); setReload(value => value + 1); }} onFailed={() => finishTracking(item)} onSignedOut={onSignedOut} />)}
          {failedTypes.length > 0 && <p className="workspace-error" role="alert">{failedTypes.map(typeName).join("、")} 目录加载失败；当前仅展示成功加载的类型，可刷新重试。</p>}
          {loading ? <p className="workspace-empty" role="status">正在读取云端作品…</p> : filtered.length ? <><div className="workspace-result-count">{filtered.length} 件作品{query || typeFilter ? " · 已筛选" : ""}</div><div className="workspace-table-wrap"><table className="workspace-table"><thead><tr><th>作品</th><th>类型</th><th>版本</th><th>更新时间</th><th><span className="workspace-sr">操作</span></th></tr></thead><tbody>{filtered.map(doc => <tr key={`${doc.doc_type}:${doc.doc_id}`}><td><div className="workspace-doc-name"><span className={`workspace-type-icon ${typeClass(doc.doc_type)}`}>{doc.doc_type === "psd" ? <Layers size={19} /> : <FileText size={19} />}</span>{canPreview(doc.doc_type) ? <a href={previewLink(doc)}>{doc.doc_id}</a> : <span>{doc.doc_id}</span>}</div></td><td><span className={`workspace-type-tag ${typeClass(doc.doc_type)}`}>{doc.doc_type === "markdown" ? "MD" : typeName(doc.doc_type)}</span></td><td>{Number.isSafeInteger(doc.version) && doc.version > 0 ? `v${doc.version}` : "准备中"}</td><td>{dateLabel(doc.updated_at)}</td><td><div className="workspace-row-actions">{canPreview(doc.doc_type) && <a className="workspace-action" title={`打开 ${doc.doc_id}`} aria-label={`打开 ${doc.doc_id}`} href={previewLink(doc)}><Eye size={16} /></a>}<button title={`下载 ${doc.doc_id}`} aria-label={`下载 ${doc.doc_id}`} disabled={Boolean(exporting)} onClick={() => exportDocument(doc)}><Download size={16} /></button></div></td></tr>)}</tbody></table></div></> : <div className="workspace-empty">{query || typeFilter ? "没有匹配的作品" : failedTypes.length ? "当前没有可展示的作品目录" : "还没有作品"}{(query || typeFilter) && <button onClick={() => { setQuery(""); setTypeFilter(""); }}>清除筛选</button>}</div>}
        </section>
      </main>
      <dialog ref={dialog} aria-labelledby="workspace-create-heading" className="workspace-create" onCancel={event => { event.preventDefault(); closeCreate(); }} onClose={() => { if (!busyCreate.current) setCreateOpen(false); }}>
        <form onSubmit={event => { event.preventDefault(); void create(); }}>
          <div className="workspace-modal-heading"><h2 id="workspace-create-heading">新建作品</h2><button type="button" aria-label="关闭创建窗口" disabled={creating} onClick={closeCreate}><X size={16} /></button></div>
          <div className="workspace-modal-body">
            <fieldset className="workspace-create-modes" disabled={creating || retryImport}><legend className="workspace-sr">创建方式</legend>
              <label><input type="radio" name="create-mode" value="blank" checked={createMode === "blank"} onChange={() => { clearImport(); setCreateMode("blank"); }} />空白作品</label>
              <label><input type="radio" name="create-mode" value="import" checked={createMode === "import"} onChange={() => { clearImport(); setCreateMode("import"); if (!canPreview(createType)) setCreateType(types.find(canPreview) ?? ""); }} />导入文件</label>
            </fieldset>
            <label htmlFor="workspace-create-type">内容类型</label><select id="workspace-create-type" value={createType} disabled={creating || retryImport} onChange={event => { clearImport(); setCreateType(event.target.value); }}>{types.filter(type => createMode === "blank" || canPreview(type)).map(type => <option value={type} key={type}>{typeName(type)}</option>)}</select>
            {createMode === "import" && <div className="workspace-import"><label htmlFor="workspace-import-file">选择文件 · 最大 32 MiB</label><input id="workspace-import-file" ref={fileInput} type="file" accept={createType === "psd" ? ".psd" : ".md,.markdown"} disabled={creating || retryImport} onChange={event => selectFile(event.target.files?.[0])} />{importFile && <p>{importFile.name} · {(importFile.size / 1024).toFixed(1)} KiB</p>}{retryImport && <p>创建结果尚未确认，可重试本次请求；文件仅在当前页面保留。关闭窗口后可重新打开继续，刷新会失去本次重试上下文。</p>}</div>}
            {importError && <p className="workspace-error" role="alert">{importError}</p>}
          </div>
          <div className="workspace-modal-footer"><button type="button" disabled={creating} onClick={closeCreate}>{retryImport ? "关闭" : "取消"}</button><button className="workspace-primary" type="submit" disabled={creating || !createType || (createMode === "import" && !importFile)}>{createMode === "import" ? <Upload size={15} /> : <Plus size={15} />}{creating ? "创建中…" : createMode === "import" ? (retryImport ? "重试导入" : "导入为新作品") : "创建"}</button></div>
        </form>
      </dialog>
    </div>
  </div>;
}