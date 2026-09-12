import { useEffect, useState } from "react";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { ClientProvider } from "./client-context.js";
import { parseRoute, type Route } from "./router.js";
import { WorkbenchPage } from "./pages/workbench.js";
import { DocumentPage } from "./pages/document.js";
import { Sidebar } from "./shell/app-shell.js";
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

  return (
    <ClientProvider client={props.client}>
      <section className="device-notice" aria-labelledby="device-notice-title">
        <h1 id="device-notice-title">请在电脑或平板上查看</h1>
        <p>移动端暂未开放。</p>
      </section>
      <div className="app">
        <Sidebar documentCount={null} />
        <main className="main">
          {route.kind === "workbench"
            ? <WorkbenchPage />
            : <DocumentPage documentId={route.documentId} threadId={route.threadId} commentIdx={route.commentIdx} />}
        </main>
      </div>
    </ClientProvider>
  );
}
