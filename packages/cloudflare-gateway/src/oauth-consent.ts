import type { GatewayOAuthConsentView } from "@unidocs/gateway-oauth";

const SCOPE_LABELS: Record<string, string> = {
  "cas:read": "View your documents",
  "cas:write": "Edit your documents",
  "cas:manage": "Manage your document storage",
};

/**
 * UniDocs consent page. Branded for the unidocs application (not the UniCAS
 * control plane) with human-readable scope descriptions.
 */
export function renderCloudflareGatewayOAuthConsent(view: GatewayOAuthConsentView): Response {
  const title = "Authorize UniDocs access";
  const scopes = view.authorization.scopes
    .map(scope => {
      const label = SCOPE_LABELS[scope] ?? scope;
      return `<li>${escapeHtml(label)}${label === scope ? "" : ` <code>${escapeHtml(scope)}</code>`}</li>`;
    })
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font:14px system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#18181b}main{border:1px solid #e4e4e7;border-radius:.75rem;padding:1.5rem}h1{font-size:1.25rem}p,li{line-height:1.5}.actions{display:flex;gap:.5rem;margin-top:1.5rem}button{border:1px solid #d4d4d8;border-radius:.4rem;background:#fff;padding:.55rem .9rem}button[value=approve]{background:#18181b;color:#fff;border-color:#18181b}</style>
</head>
<body><main>
<h1>${title}</h1>
<p><strong>${escapeHtml(view.user.displayName ?? view.user.principalId)}</strong> is signing in to UniDocs (client <code>${escapeHtml(view.authorization.clientId)}</code>) for tenant <code>${escapeHtml(view.authorization.tenantId)}</code>.</p>
<ul>${scopes}</ul>
<form method="post" action="${escapeHtml(view.decisionEndpoint)}">
<input type="hidden" name="transaction_id" value="${escapeHtml(view.authorization.transactionId)}">
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve">Approve</button></div>
</form>
</main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character]!);
}
