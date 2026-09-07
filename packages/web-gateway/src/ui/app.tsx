import { lazy, Suspense, useEffect, useState } from "react";
import { REDIRECT_PATH } from "./config.js";
import { clearSession, completeLogin, loadSession, type OAuthTokenSession } from "./oauth.js";
import { matchRoute, useHashRoute } from "./router.js";
import { DocumentsView } from "./views/workspace-documents.js";
import { LoginView } from "./views/login.js";

const StudioView = lazy(() => import("./studio/studio.js").then(module => ({ default: module.StudioView })));
const CloudPreview = lazy(() => import("./views/cloud-preview.js").then(module => ({ default: module.CloudPreview })));

/**
 * Root component: hash routing, OAuth callback handling, and the session
 * gate. The tenant is never typed — it comes from the access token after the
 * Google OIDC login.
 */
export function App() {
  const route = useHashRoute();
  const [session, setSession] = useState<OAuthTokenSession | null>(() => loadSession());
  const [callbackError, setCallbackError] = useState<string | null>(null);

  // OAuth callback: exchange the code for a token, then return to the list.
  useEffect(() => {
    if (window.location.pathname !== REDIRECT_PATH) return;
    completeLogin(new URL(window.location.href))
      .then((next) => {
        setSession(next);
        window.history.replaceState(null, "", "/ui/");
        window.location.hash = "/documents";
      })
      .catch((err) => {
        setCallbackError(err instanceof Error ? err.message : String(err));
        window.history.replaceState(null, "", "/ui/");
      });
  }, []);

  const signedOut = () => {
    clearSession();
    setSession(null);
    setCallbackError(null);
    window.location.hash = "/documents";
  };

  if (route !== "/documents" && !route.startsWith("/preview/") && window.location.pathname !== REDIRECT_PATH) {
    return <Suspense fallback={<p role="status">正在打开工作台…</p>}><StudioView /></Suspense>;
  }

  if (!session) {
    return (
      <>
        {callbackError ? <p className="error app-error" role="alert">{callbackError}</p> : null}
        <LoginView />
      </>
    );
  }

  if (route === "/documents") {
    return <DocumentsView key={session.tenantId} session={session} onSignedOut={signedOut} />;
  }

  if (route.startsWith("/preview/")) {
    try {
      const match = matchRoute("/preview/:docType/:docId", route);
      if (match) return <Suspense fallback={<p role="status">正在打开预览…</p>}><CloudPreview key={`${session.tenantId}:${route}`} session={session} docType={match.params.docType!} docId={match.params.docId!} onSignedOut={signedOut} /></Suspense>;
    } catch { }
    return <main className="shell"><p role="alert">无效的作品链接</p><a href="#/documents">返回作品列表</a></main>;
  }

  // Anything else after login goes to the document list.
  return <DocumentsView key={session.tenantId} session={session} onSignedOut={signedOut} />;
}
