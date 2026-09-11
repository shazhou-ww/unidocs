import { ArrowUpRight, BookOpenText, Braces, ExternalLink, Menu, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { guides, guideSections } from "./content.js";
import { MarkdownArticle } from "./MarkdownArticle.js";
import { references } from "./reference-config.js";
import { navigate, usePath } from "./router.js";

const ApiReference = lazy(async () => {
  const module = await import("./ApiReference.js");
  return { default: module.ApiReference };
});

function SiteLink({ path, active, children, onNavigate }: {
  readonly path: string;
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly onNavigate: () => void;
}) {
  return (
    <a
      className={`nav-link${active ? " active" : ""}`}
      href={path}
      onClick={(event) => {
        event.preventDefault();
        navigate(path);
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}

export function App() {
  const path = usePath();
  const [mobileOpen, setMobileOpen] = useState(false);
  const guide = guides.find((item) => item.path === path)
    ?? (path === "/" || path === "/unicas" ? guides[0] : undefined);
  const reference = references.find((item) => item.path === path);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);

  return (
    <div className={`docs-app${reference ? " reference-route" : ""}`}>
      <header className="site-header">
        <a className="brand" href="/unicas" onClick={(event) => { event.preventDefault(); navigate("/unicas"); }}>
          <span className="brand-mark">U</span>
          <span>UniCAS</span>
          <span className="brand-section">Documentation</span>
        </a>
        <div className="header-actions">
          <a className="portal-link" href="https://unicas.shazhou.work/admin/" target="_blank" rel="noreferrer">
            Open Admin Portal <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <button className="menu-button" type="button" aria-label="Toggle navigation" onClick={() => setMobileOpen((open) => !open)}>
            {mobileOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </header>

      <aside className={`site-sidebar${mobileOpen ? " open" : ""}`} aria-label="Documentation navigation">
        <nav>
          {guideSections.map((section) => (
            <div className="nav-group" key={section}>
              <div className="nav-group-title">{section}</div>
              {guides.filter((item) => item.section === section).map((item) => (
                <SiteLink key={item.path} path={item.path} active={guide?.path === item.path && !reference} onNavigate={() => setMobileOpen(false)}>
                  <BookOpenText size={15} aria-hidden="true" /> {item.title}
                </SiteLink>
              ))}
            </div>
          ))}
          <div className="nav-group">
            <div className="nav-group-title">API Reference</div>
            {references.map((item) => (
              <SiteLink key={item.path} path={item.path} active={path === item.path} onNavigate={() => setMobileOpen(false)}>
                <Braces size={15} aria-hidden="true" /> {item.title}
              </SiteLink>
            ))}
          </div>
        </nav>
        <a className="sidebar-external" href="https://unicas.shazhou.work" target="_blank" rel="noreferrer">
          UniCAS service <ExternalLink size={14} aria-hidden="true" />
        </a>
      </aside>

      <main className="site-main">
        {reference ? (
          <Suspense fallback={<div className="reference-loading">Loading API reference...</div>}>
            <ApiReference definition={reference} />
          </Suspense>
        ) : null}
        {guide ? <MarkdownArticle guide={guide} /> : null}
        {!guide && !reference ? (
          <div className="not-found">
            <span>404</span>
            <h1>Page not found</h1>
            <button type="button" onClick={() => navigate("/unicas")}>Return to documentation</button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
