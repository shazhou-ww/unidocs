/**
 * Stack administration UI entry. Browser code must never embed tenant JWTs,
 * Google client secrets, or session signing material.
 */
export const CAS_ADMIN_UI_PACKAGE = "@unicas/admin-webui/ui" as const;

export { App } from "./app.js";
export { UserMenu } from "./user-menu.js";
export { MyStacksView } from "./views/my-stacks.js";
export { StackView } from "./views/stack.js";
export { InvitationView } from "./views/invitations.js";
export { LoginErrorView } from "./views/login-error.js";
export { MembersView } from "./views/members.js";
export { IssuerView } from "./views/issuer.js";
export { ControlAuditView } from "./views/control-audit.js";
export { UsageView } from "./views/usage.js";
export { api, ApiError, SessionExpiredError, readCsrfToken, ifMatch } from "./api.js";
export { useHashRoute, matchRoute, navigate } from "./router.js";
