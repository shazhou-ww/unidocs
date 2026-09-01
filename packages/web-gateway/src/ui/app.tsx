import { useEffect, useState } from "react";
import { REDIRECT_PATH } from "./config.js";
import { completeLogin, loadSession, type OAuthTokenSession } from "./oauth.js";
import { useHashRoute } from "./router.js";
import { DocumentsView } from "./views/documents.js";
import { LoginView } from "./views/login.js";

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
    setSession(null);
    setCallbackError(null);
    window.location.hash = "/";
  };

  if (!session) {
    return (
      <>
        {callbackError ? <p className="error app-error" role="alert">{callbackError}</p> : null}
        <LoginView />
      </>
    );
  }

  if (route === "/documents") {
    return <DocumentsView session={session} onSignedOut={signedOut} />;
  }

  // Anything else after login goes to the document list.
  return <DocumentsView session={session} onSignedOut={signedOut} />;
}
