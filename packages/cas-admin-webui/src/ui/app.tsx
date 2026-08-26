import { useEffect, useState } from "react";
import { api } from "./api.js";
import { matchRoute, navigate, useHashRoute } from "./router.js";
import { MyStacksView } from "./views/my-stacks.js";
import { StackView } from "./views/stack.js";
import { InvitationView } from "./views/invitations.js";
import { LoginErrorView } from "./views/login-error.js";
import { ErrorState, LoadingState, Page } from "./components.js";
import { formatErrorSafe } from "./views/view-helpers.js";

interface MeResponse {
  readonly identity: {
    readonly displayName: string | null;
    readonly emailForDisplay: string | null;
  };
  readonly memberships: readonly unknown[];
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<MeResponse>("/admin/me")
      .then(setMe)
      .catch((caught) => setError(formatErrorSafe(caught)));
  }, []);

  async function logout() {
    try {
      await fetch("/admin/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      window.location.href = "/admin/auth/login";
    }
  }

  let content: React.ReactNode;
  const stackMatch = matchRoute("/stacks/:stackId", route);
  const inviteMatch = matchRoute("/invitations/:token", route);
  if (route === "/login-error") {
    content = <LoginErrorView />;
  } else if (stackMatch) {
    content = <StackView stackId={stackMatch.params.stackId!} />;
  } else if (inviteMatch) {
    content = <InvitationView token={inviteMatch.params.token!} />;
  } else {
    content = <MyStacksView />;
  }

  if (me === null && error === null) {
    return <Page title="CAS Admin"><LoadingState label="Loading session…" /></Page>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" href="#/">CAS Admin</a>
        <div className="app-header-right">
          {me ? (
            <>
              <span className="muted">{me.identity.displayName ?? me.identity.emailForDisplay}</span>
              <button type="button" className="btn btn-plain" onClick={() => void logout()}>Sign out</button>
            </>
          ) : null}
        </div>
      </header>
      {error ? <div className="app-error"><ErrorState message={error} /></div> : null}
      <main className="app-main">{content}</main>
    </div>
  );
}

export { navigate };
