import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { startLogin } from "../oauth.js";

/**
 * Sign-in screen. Login is pure Google OIDC: the tenant is derived
 * server-side from the account's membership, never typed by the user.
 */
export function LoginView() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = () => {
    setStarting(true);
    setError(null);
    startLogin().catch((err) => {
      setStarting(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <main className="shell">
      <h1>UniDocs</h1>
      <p className="muted">Sign in with your Google account to browse your documents.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="login-actions">
        <button type="button" className="btn btn-primary" onClick={signIn} disabled={starting}>
          {starting ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : null}
          {starting ? "Signing in…" : "Sign in with Google"}
        </button>
      </div>
    </main>
  );
}
