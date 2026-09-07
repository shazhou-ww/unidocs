/**
 * Gateway webui entry. Browser code must never embed tenant JWTs, Google
 * client secrets, or session signing material.
 */
export { App } from "./app.js";
export { LoginView } from "./views/login.js";
export { DocumentsView } from "./views/workspace-documents.js";
export { ApiError } from "./api.js";
export { useHashRoute, matchRoute, navigate } from "./router.js";
