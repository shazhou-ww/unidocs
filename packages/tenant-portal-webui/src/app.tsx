import { useEffect, useState } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "./client-context.js";
import { parseRoute, type Route } from "./router.js";
import { WorkbenchPage } from "./pages/workbench.js";
import { DocumentPage } from "./pages/document.js";
import { Sidebar } from "./shell/app-shell.js";
import { Monitor } from "lucide-react";
import seal from "./assets/studio-seal.svg";
import "./styles.css";

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App(props: { client: TenantPortalClient }) {
  const route = useHashRoute();
  const [documentCount, setDocumentCount] = useState<number | null>(null);

  return (
    <ClientProvider client={props.client}>
      <section id="device-notice" className="device-notice" aria-labelledby="device-notice-title">
        <div className="brand"><span className="brand-mark"><img src={seal} alt="" /></span>UniDocs</div>
        <div className="device-notice-content">
          <Monitor size={32} aria-hidden="true" />
          <h1 id="device-notice-title">请在电脑或平板上查看</h1>
          <p>移动端暂未开放。</p>
        </div>
      </section>
      <div id="app" className="app">
        <Sidebar documentCount={documentCount} />
        <main className="main">
          {route.kind === "workbench"
            ? <WorkbenchPage onDocumentCount={setDocumentCount} />
            : <DocumentPage key={route.documentId} documentId={route.documentId} threadId={route.threadId} commentIdx={route.commentIdx} />}
        </main>
      </div>
    </ClientProvider>
  );
}
