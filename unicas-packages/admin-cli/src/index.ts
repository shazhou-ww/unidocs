/**
 * @unicas/admin-cli — UniCAS control-plane management CLI.
 *
 * Programmatic surface: Google OIDC login with BFF session exchange, session
 * persistence, the typed `/admin` HTTP client wiring, the tool catalog, and
 * the stdio MCP server. The `unicas` binary in `src/cli.ts` wires these
 * together.
 */

export { loadConfig, DEFAULT_ADMIN_ORIGIN } from "./config.js";
export type { CliConfig } from "./config.js";
export { TokenStore } from "./store.js";
export type { PersistedSession, TokenStoreOptions } from "./store.js";
export { CliError } from "./errors.js";
export { runLoginFlow, openBrowser, buildOpenBrowserCommand } from "./oauth/login.js";
export type { LoginFlowOptions, LoginFlowResult } from "./oauth/login.js";
export { revokeAndClearSession } from "./oauth/logout.js";
export type { LogoutOptions, LogoutResult } from "./oauth/logout.js";
export { TOOL_CATALOG, getToolDefinition, generateIdempotencyKey } from "./mcp/catalog.js";
export type { ToolDefinition, ControlPlaneToolScope } from "./mcp/catalog.js";
export { runMcpStdioServer } from "./mcp/stdio-server.js";
export type { McpStdioServerOptions } from "./mcp/stdio-server.js";
export { main } from "./cli.js";
