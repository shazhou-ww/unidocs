import { useEffect, useState } from "react";
import { Cable, LogOut } from "lucide-react";
import { api } from "./api.js";
import { matchRoute, navigate, useHashRoute } from "./router.js";
import { MyStacksView } from "./views/my-stacks.js";
import { StackView } from "./views/stack.js";
import { InvitationView } from "./views/invitations.js";
import { LoginErrorView } from "./views/login-error.js";
import { Button, ErrorState, LoadingState, Page } from "./components.js";
import { McpConfigurationDialog } from "./mcp-configuration-dialog.js";
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
  const [mcpConfigurationOpen, setMcpConfigurationOpen] = useState(false);

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
    content = (
      <StackView
        stackId={stackMatch.params.stackId!}
        onOpenMcpConfiguration={() => setMcpConfigurationOpen(true)}
        onLogout={() => void logout()}
      />
    );
  } else if (inviteMatch) {
    content = <InvitationView token={inviteMatch.params.token!} />;
  } else {
    content = <MyStacksView />;
  }

  if (me === null && error === null) {
    return <Page title="CAS Admin"><LoadingState label="Loading session…" /></Page>;
  }

  return (
    <div className={`app${stackMatch ? " app-stack" : ""}`}>
      <header className="app-header">
        <a className="brand" href="#/">
          <span className="brand-mark">U</span>
          <span>UniCAS</span>
          <span className="brand-section">Admin</span>
        </a>
        <div className="app-header-right">
          {me ? (
            <>
              <span className="muted">{me.identity.displayName ?? me.identity.emailForDisplay}</span>
              <span className="mcp-header-action">
                <Button
                  variant="plain"
                  icon={<Cable size={15} />}
                  onClick={() => setMcpConfigurationOpen(true)}
                >
                  Connect AI tools
                </Button>
              </span>
              <Button variant="plain" icon={<LogOut size={15} />} onClick={() => void logout()}>Sign out</Button>
            </>
          ) : null}
        </div>
      </header>
      {error ? <div className="app-error"><ErrorState message={error} /></div> : null}
      <main className="app-main">{content}</main>
      <McpConfigurationDialog
        open={mcpConfigurationOpen}
        onClose={() => setMcpConfigurationOpen(false)}
      />
    </div>
  );
}

export { navigate };
