import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Cloud, LockKeyhole, RefreshCw, LogOut, Monitor } from "lucide-react";
import { ApiError, createPsdPreviewTransport, readMarkdownPreview } from "../api.js";
import type { OAuthTokenSession } from "../oauth.js";
import { markdownPreviewHtml } from "./markdown-preview.js";
import logo from "../studio/logo.svg";
import "./cloud-preview.css";

export interface CloudPreviewProps {
  session: OAuthTokenSession;
  docType: string;
  docId: string;
  onSignedOut: () => void;
}

export function CloudPreview({ session, docType, docId, onSignedOut }: CloudPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reload, setReload] = useState(0);
  const [content, setContent] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [dimensions, setDimensions] = useState("");
  const [layers, setLayers] = useState<Array<{ id: string; name: string; visible: boolean }>>([]);
  const signOutRef = useRef(onSignedOut); signOutRef.current = onSignedOut;

  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    const canvas = canvasRef.current;
    const clear = () => { if (canvas) { canvas.width = 1; canvas.height = 1; delete canvas.dataset.ready; } };
    clear(); setContent(""); setVersion(null); setLayers([]); setDimensions(""); setError(""); setDenied(false); setLoading(true);
    const load = async () => {
      if (window.matchMedia?.("(max-width: 760px)").matches) { setLoading(false); return; }
      if (docType === "markdown") {
        const result = await readMarkdownPreview(session.tenantId, docId, controller.signal);
        if (disposed) return;
        setContent(markdownPreviewHtml(result.content)); setVersion(result.version);
      } else if (docType === "psd") {
        const { CasBlobStore, loadDoc, RenderCore } = await import("@unidocs/psd-client");
        if (disposed) return;
        const transport = createPsdPreviewTransport(session.tenantId, docId, controller.signal);
        const store = new CasBlobStore(transport);
        const result = await loadDoc({ ...transport, store, type: "psd", docId });
        if (disposed) return;
        const { width, height } = result.doc.canvas;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) {
          throw new Error("当前只读预览支持不超过 1600 万像素的作品");
        }
        const core = new RenderCore(result.doc, store);
        const pixels = await core.composite();
        if (disposed) return;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("浏览器无法创建预览画布");
        canvas.width = pixels.width; canvas.height = pixels.height;
        const image = context.createImageData(pixels.width, pixels.height); image.data.set(pixels.data); context.putImageData(image, 0, 0);
        canvas.dataset.ready = "true";
        setVersion(result.version); setDimensions(`${width} × ${height} px`);
        setLayers(result.doc.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible })));
      } else throw new Error("此类型暂不支持在线预览");
      if (!disposed) setLoading(false);
    };
    load().catch(reason => {
      if (disposed) return;
      clear(); setContent(""); setVersion(null); setLayers([]); setLoading(false);
      if (reason instanceof ApiError && reason.status === 401) { signOutRef.current(); return; }
      setDenied(reason instanceof ApiError && reason.status === 403);
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { disposed = true; controller.abort(); clear(); };
  }, [session.tenantId, docType, docId, reload]);

  return <div className="cloud-preview">
    <section className="cloud-mobile"><img src={logo} alt="UniDocs" /><Monitor /><h1>请在电脑或平板上查看</h1></section>
    <div className="cloud-desktop">
      <header className="cloud-header"><a href="#/documents" className="cloud-brand"><img src={logo} alt="" />UniDocs</a><span className="cloud-header-label"><Cloud size={14} />云端作品</span><span className="cloud-grow" /><button onClick={onSignedOut}><LogOut size={15} />退出登录</button></header>
      <div className="cloud-title"><a href="#/documents"><ArrowLeft size={15} />返回作品列表</a><h1>{docId}</h1><div className="cloud-meta"><span className="cloud-type">{docType === "markdown" ? "Markdown" : docType.toUpperCase()}</span><span><LockKeyhole size={13} />只读</span>{version !== null && <span data-testid="loaded-version">已加载 v{version}</span>}<span className="cloud-grow" /><span>{dimensions}</span><button disabled={loading || denied} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新当前版本</button></div></div>
      <div className="cloud-boundary">云端只读预览 · 不写入本地样例存储，不自动跟随更新。{docType === "markdown" ? "外链图片暂不加载。" : ""}</div>
      {loading && <p className="cloud-status" role="status">正在读取云端作品…</p>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
      <div className={`cloud-body ${docType === "psd" ? "cloud-psd" : ""}`}>
        {docType === "markdown" && !loading && !error && <article className="cloud-prose">{content ? <div dangerouslySetInnerHTML={{ __html: content }} /> : <p className="cloud-empty">文档暂无内容</p>}</article>}
        {docType === "psd" && <><div className="cloud-canvas-area"><canvas ref={canvasRef} width={1} height={1} aria-label="云端 PSD 只读画布" hidden={loading || Boolean(error)} /></div>{!loading && !error && <aside className="cloud-layers"><h2>图层 · {layers.length}</h2>{layers.map(layer => <div key={layer.id}><span>{layer.name || layer.id}</span><small>{layer.visible ? "可见" : "隐藏"}</small></div>)}</aside>}</>}
      </div>
    </div>
  </div>;
}