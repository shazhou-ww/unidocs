import { useEffect, useRef, useState } from "react";
import { Cloud, Download, Eye, EyeOff, Layers, Monitor, RotateCcw, Save, SquarePen } from "lucide-react";
import { EditorDraft, RenderCore, type DraftCandidate } from "@unidocs/psd-client";
import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import { createStudioSample } from "./sample.js";
import { StudioStorage } from "./storage.js";
import logo from "./logo.svg";
import "./studio.css";

type Outcome = "success" | "conflict" | "unknown";
type Version = { version: number; doc: PsdDoc };
type Runtime = { draft: EditorDraft; core: RenderCore; versions: Version[]; pending: DraftCandidate | null };

const store = { get: async () => null, put: async (): Promise<string> => { throw new Error("本地样例不写入资源服务"); } };

export function StudioView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtime = useRef<Runtime | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(false);
  const paintSequence = useRef(0);
  const storage = useRef(new StudioStorage());
  const storageRevision = useRef(0);
  const unsaved = useRef(false);
  const currentView = useRef({ editing: false, viewVersion: 1 });
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, updateEditing] = useState(false);
  const [viewVersion, updateViewVersion] = useState(1);
  const [storageFailed, setStorageFailed] = useState(false);
  const [selected, setSelected] = useState("headline");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("success");

  function setEditing(value: boolean) { currentView.current.editing = value; updateEditing(value); }
  function setViewVersion(value: number) { currentView.current.viewVersion = value; updateViewVersion(value); }

  async function persist(target: Runtime) {
    const checkpoint = await target.draft.checkpoint();
    storageRevision.current = await storage.current.save({
      schema: 1, versions: target.versions,
      draft: checkpoint, ...currentView.current
    }, storageRevision.current);
    unsaved.current = false; setStorageFailed(false);
  }

  async function paint(core: RenderCore) {
    const sequence = ++paintSequence.current;
    const pixels = await core.composite();
    if (!alive.current || sequence !== paintSequence.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) throw new Error("无法显示作品画布");
    canvas.width = pixels.width; canvas.height = pixels.height;
    const image = context.createImageData(pixels.width, pixels.height); image.data.set(pixels.data);
    context.putImageData(image, 0, 0); canvas.dataset.ready = "true";
  }

  function makeDraft(doc: PsdDoc, version: number) {
    const core = new RenderCore(doc, store);
    const draft = new EditorDraft({
      doc, baseVersion: version, render: {
        applyOp: operation => core.applyOp(operation), reset: async next => { core.reset(next); },
      }
    });
    return { core, draft };
  }

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    if (matchMedia("(max-width: 760px)").matches) return () => { alive.current = false; };
    const initialize = async () => {
      const saved = await storage.current.load();
      if (cancelled) return;
      let state: Runtime;
      if (saved) {
        const snapshot = saved.snapshot;
        if (!snapshot.versions.some(item => item.version === snapshot.viewVersion)
          || !snapshot.versions.some(item => item.version === snapshot.draft.baseVersion)) throw new Error("本地版本记录不完整，原数据未覆盖");
        const core = new RenderCore(snapshot.draft.doc, store);
        const draft = EditorDraft.restore(snapshot.draft, { applyOp: operation => core.applyOp(operation), reset: async doc => { core.reset(doc); } });
        state = { core, draft, versions: snapshot.versions, pending: snapshot.draft.candidate };
        storageRevision.current = saved.revision;
        setEditing(snapshot.editing); setViewVersion(snapshot.viewVersion);
      } else {
        const doc = createStudioSample();
        state = { ...makeDraft(doc, 1), versions: [{ version: 1, doc }], pending: null };
      }
      runtime.current = state;
      const display = currentView.current.editing ? state.core : new RenderCore(state.versions.find(item => item.version === currentView.current.viewVersion)!.doc, store);
      await paint(display);
      if (cancelled) return;
      if (!saved) await persist(state);
      if (cancelled) return;
      setReady(true);
      setMessage(saved ? (state.pending ? "已恢复待核实提交，草稿仍冻结" : "已恢复此浏览器的本地版本与草稿") : "本地样例已保存到此浏览器");
    };
    initialize().catch(reason => { if (!cancelled) { setError(`无法打开本地存储：${String(reason)}。请检查浏览器设置后刷新，原数据不会被重置。`); } });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (unsaved.current || busyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { cancelled = true; alive.current = false; paintSequence.current++; window.removeEventListener("beforeunload", beforeUnload); };
  }, []);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; unsaved.current = true; setBusy(true); setError(""); setMessage("");
    try {
      await action();
      if (runtime.current) {
        try { await persist(runtime.current); }
        catch (reason) { setStorageFailed(true); throw reason; }
      }
      setMessage(runtime.current?.pending ? "待核实提交已保存到此浏览器，草稿仍冻结" : "本地版本与草稿已保存到此浏览器，未上传云端");
    } catch (reason) { setMessage(""); setError(`当前操作未完整保存：${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { busyRef.current = false; if (alive.current) { setBusy(false); setRevision(value => value + 1); } }
  }

  const state = runtime.current;
  const draft = state?.draft;
  const displayed = editing ? draft?.doc : state?.versions.find(item => item.version === viewVersion)?.doc;
  const layer = displayed?.layers.find(item => item.id === selected);
  const locked = busy || !ready || Boolean(draft?.frozen);

  const apply = (operation: PsdOp) => run(async () => {
    if (!state || !editing || draft?.frozen) return;
    await state.draft.applyLocal(operation); await paint(state.core);
  });

  const changeMode = (next: boolean) => run(async () => {
    if (!state) return;
    if (next && !state.draft.dirty && state.draft.baseVersion !== viewVersion) Object.assign(state, makeDraft(state.versions.find(item => item.version === viewVersion)!.doc, viewVersion));
    if (next) { await paint(state.core); setViewVersion(state.draft.baseVersion); }
    else await paint(new RenderCore(state.versions.find(item => item.version === viewVersion)!.doc, store));
    setEditing(next);
  });

  const save = () => run(async () => {
    if (!state || !state.draft.dirty) return;
    const candidate = await state.draft.prepareCommit();
    state.pending = candidate;
    try { await persist(state); }
    catch (reason) { setStorageFailed(true); throw reason; }
    unsaved.current = true;
    if (candidate.baseVersion !== state.versions.at(-1)!.version || outcome === "conflict") {
      await state.draft.acceptResult(candidate.candidateId, { status: "rejected" });
      state.pending = null;
      setError("本地冲突演示：提交被拒绝，草稿及基础版本均保留。"); return;
    }
    if (outcome === "unknown") {
      state.pending = candidate; await state.draft.acceptResult(candidate.candidateId, { status: "unknown" });
      return;
    }
    await commit(state, candidate);
  });

  async function commit(target: Runtime, candidate: DraftCandidate) {
    const version = candidate.baseVersion + 1;
    const doc = target.draft.doc;
    await target.draft.acceptResult(candidate.candidateId, { status: "committed", version });
    if (!target.versions.some(item => item.version === version)) target.versions.push({ version, doc });
    await paint(target.core);
    target.pending = null; setViewVersion(version);
  }

  const exportPng = () => run(async () => {
    const canvas = canvasRef.current; if (!canvas) return;
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片导出失败");
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `unidocs-studio-v${viewVersion}${editing && draft?.dirty ? "-draft" : ""}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return <div className="studio" data-revision={revision}>
    <section className="studio-mobile"><img src={logo} alt="UniDocs" /><Monitor /><h1>请在电脑或平板上查看</h1><p>移动端暂未开放。</p></section>
    <div className="studio-desktop">
      <aside className="studio-sidebar"><a className="studio-brand" href="#/"><img src={logo} alt="" />UniDocs</a><p className="studio-space">创作工作台</p><div className="studio-nav"><Layers size={16} />本地作品<span>1</span></div><a className="studio-cloud" href="#/documents" onClick={event => { if ((unsaved.current || busyRef.current) && !window.confirm("尚有修改未写入浏览器存储，离开可能丢失。继续前往云端作品？")) event.preventDefault(); }}><Cloud size={16} />云端作品</a><div className="studio-sidebar-footer">早期预览 · Iteration 02<br />真实 PSD 引擎 / 本地持久化</div></aside>
      <main className="studio-main">
        <header className="studio-top"><span>本地作品 <span className="studio-divider">/</span> 共创空间 · 封面设计</span><button title="下载当前画面 PNG" aria-label="下载当前画面 PNG" disabled={busy || !ready} onClick={exportPng}><Download size={16} /></button></header>
        <div className="studio-heading"><h1>共创空间 · 封面设计</h1><div className="studio-meta"><span className="studio-type">PSD</span><span>设计</span><span>UniDocs</span><span className="studio-grow" /><span>960 × 640 px</span></div></div>
        <div className="studio-disclaimer">本地试验 · 版本和草稿保存在此浏览器，刷新可恢复；不同步云端。同一浏览器的使用者共享此样例，清除站点数据会删除本地记录。</div>
        <div className="studio-toolbar"><div className="studio-modes"><button className={!editing ? "selected" : ""} disabled={busy || !ready} onClick={() => changeMode(false)}><Eye size={15} />预览</button><button className={editing ? "selected" : ""} disabled={busy || !ready} onClick={() => changeMode(true)}><SquarePen size={15} />编辑</button></div>
          <select aria-label="查看本地版本" disabled={busy || !ready || editing} value={viewVersion} onChange={event => { const version = Number(event.target.value); void run(async () => { if (!state) return; await paint(new RenderCore(state.versions.find(item => item.version === version)!.doc, store)); setViewVersion(version); }); }}>
            {(state?.versions ?? [{ version: 1 }]).map(item => <option key={item.version} value={item.version}>v{item.version}{item.version === state?.versions.at(-1)?.version ? " · 最新" : ""}</option>)}
          </select><span className="studio-draft">{draft?.dirty ? `未保存草稿 · 基于 v${draft.baseVersion}` : "本地版本"}</span><span className="studio-grow" />
          {editing && <button className="studio-primary" disabled={locked || !draft?.dirty} onClick={save}><Save size={15} />保存到本地版本</button>}
        </div>
        {error && <div className="studio-error" role="alert">{error}</div>}
        {storageFailed && <div className="studio-pending"><span>当前修改尚未持久化</span><button disabled={busy} onClick={() => run(async () => { })}>重试本地存储</button></div>}
        {message && <div className="studio-message" role="status">{message}</div>}
        {state?.pending && <div className="studio-pending"><span>结果未知 · 演示核实结果</span><button disabled={busy} onClick={() => run(async () => { if (state.pending) await commit(state, state.pending); })}>确认已提交</button><button disabled={busy} onClick={() => run(async () => { if (!state.pending) return; await state.draft.acceptResult(state.pending.candidateId, { status: "rejected" }); state.pending = null; setMessage("已确认未提交，草稿保留并解冻"); })}>确认未提交</button></div>}
        <div className="studio-workspace"><div className="studio-canvas-area"><div className="studio-canvas-label"><span>RGB / 8 BIT</span><span>{editing ? "编辑草稿" : `版本 v${viewVersion}`}</span></div><div className="studio-stage"><canvas ref={canvasRef} width={960} height={640} aria-label="PSD 作品画布" /></div><div className="studio-canvas-label"><span>{displayed?.layers.length ?? 5} 个图层</span><span>{busy ? "处理中…" : "RenderCore · 本地合成"}</span></div></div>
          <aside className="studio-inspector"><h2>图层</h2><div className="studio-layer-list">{[...(displayed?.layers ?? [])].reverse().map(item => <div className={`studio-layer ${selected === item.id ? "selected" : ""}`} key={item.id}><button onClick={() => setSelected(item.id)}><Layers size={14} /><span>{item.name}</span></button><button title={`${item.visible ? "隐藏" : "显示"}${item.name}`} aria-label={`${item.visible ? "隐藏" : "显示"}${item.name}`} disabled={locked || !editing} onClick={() => apply({ kind: "set_props", payload: { layerId: item.id, props: { visible: !item.visible } } })}>{item.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>)}</div>
            <div className="studio-properties"><h2>图层属性</h2><p>{layer?.name}</p><label htmlFor="studio-opacity">透明度 <span>{Math.round((layer?.opacity ?? 1) * 100)}%</span></label><input id="studio-opacity" type="range" min="0" max="100" step="5" value={Math.round((layer?.opacity ?? 1) * 100)} disabled={locked || !editing || !layer} onChange={event => { if (layer) void apply({ kind: "set_props", payload: { layerId: layer.id, props: { opacity: Number(event.target.value) / 100 } } }); }} />
              <button className="studio-reset" disabled={locked || !draft?.dirty} onClick={() => run(async () => { if (!state || !window.confirm("放弃当前未保存的草稿？")) return; const saved = state.versions.find(item => item.version === state.draft.baseVersion)!; Object.assign(state, makeDraft(saved.doc, saved.version)); await paint(state.core); setViewVersion(saved.version); setEditing(true); setMessage("已恢复保存版本"); })}><RotateCcw size={14} />放弃草稿</button>
            </div>
            <details className="studio-simulation"><summary>提交模拟</summary><label htmlFor="studio-outcome">下次保存结果</label><select id="studio-outcome" value={outcome} disabled={locked} onChange={event => setOutcome(event.target.value as Outcome)}><option value="success">成功</option><option value="conflict">版本冲突</option><option value="unknown">超时，结果未知</option></select></details>
          </aside>
        </div>
      </main>
    </div>
  </div>;
}