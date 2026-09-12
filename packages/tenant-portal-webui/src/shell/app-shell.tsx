/**
 * 应用外壳：左侧固定侧边栏 + 主区，对齐 docs/design/unidocs-mock.css 的 .sidebar / .main。
 *
 * 侧边栏的标签导航在本轮不接真实数据（tag 还没有进 tenant 协议），只渲染「我的作品」
 * 这一项和底部身份块；标签区留空而不是伪造条目。
 */
import { FileText, LayoutGrid, LockKeyhole } from "lucide-react";
import seal from "../assets/studio-seal.svg";

export function Sidebar(props: { documentCount: number | null }) {
  return (
    <aside className="sidebar" id="sidebar">
      <a href="#/" className="brand">
        <span className="brand-mark"><img src={seal} alt="" /></span>
        UniDocs
      </a>
      <div className="workspace">个人工作空间</div>

      <nav aria-label="主导航">
        <a className="nav-item active" href="#/">
          <LayoutGrid size={14} aria-hidden="true" />
          我的作品
          {props.documentCount !== null && <span className="count">{props.documentCount}</span>}
        </a>
      </nav>

      <div className="sidebar-bottom">
        <div className="row">
          <span className="avatar">我</span>
          <div>
            <div style={{ fontSize: 12 }}>我的工作空间</div>
            <small style={{ fontSize: 10 }}>仅自己可访问</small>
          </div>
          <LockKeyhole size={13} aria-hidden="true" />
        </div>
        <div className="prototype">本地样例数据 · 未接生产服务</div>
      </div>
    </aside>
  );
}

export function Topbar(props: { children: React.ReactNode }) {
  return <header className="topbar">{props.children}</header>;
}

export function WorkspaceCrumb() {
  return (
    <div className="breadcrumb">
      工作空间 <span>/</span><span>我的作品</span>
    </div>
  );
}

export function DocumentCrumb(props: { title: string }) {
  return (
    <div className="breadcrumb">
      <a href="#/" title="返回我的作品"><FileText size={13} aria-hidden="true" /></a>
      <a href="#/" className="desktop-text">我的作品</a>
      <span>/</span>
      <span>{props.title}</span>
    </div>
  );
}

export function PrivacyNote() {
  return (
    <div className="row muted" style={{ fontSize: 11 }}>
      <LockKeyhole size={12} aria-hidden="true" />
      仅自己可访问
    </div>
  );
}
