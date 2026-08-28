/**
 * Thin wrapper over the MCP SDK client (Streamable HTTP) that talks to the
 * remote Unicas control-plane MCP server using the persisted OAuth session.
 *
 * The SDK transport attaches the stored bearer token, and on a 401 the SDK's
 * `auth()` orchestrator refreshes the token through the same provider. Only an
 * interactive `unicas login` can mint new tokens; anything else surfaces as
 * `NeedsLoginError`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PersistedSession, TokenStore } from "../store.js";
import { PersistentOAuthClientProvider } from "../oauth/provider.js";
import { CliError } from "../errors.js";

export const UNICAS_CLI_VERSION = "0.1.0";

export interface RemoteClientOptions {
  readonly serverUrl: string;
  readonly store: TokenStore;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Log sink for non-protocol output (stderr). */
  readonly log?: (message: string) => void;
}

export interface ToolCallResult {
  /** Parsed structured content from the tool result. */
  readonly structuredContent: Record<string, unknown>;
  /** Raw text of the first text content block, when present. */
  readonly text: string | null;
  /** True when the tool reported an error (still a successful MCP call). */
  readonly isError: boolean;
}

export class UnicasRemoteClient {
  readonly #options: RemoteClientOptions;
  #client: Client | undefined;
  #transport: StreamableHTTPClientTransport | undefined;

  constructor(options: RemoteClientOptions) {
    this.#options = options;
  }

  /** Calls a control-plane tool by name, connecting lazily on first use. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const client = await this.#connect();
    try {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
      return normalizeToolResult(result);
    } catch (error) {
      throw mapClientError(error, name);
    }
  }

  /** Lists tools advertised by the remote server. */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const client = await this.#connect();
    try {
      const result = await client.listTools();
      return result.tools.map((tool) => ({ name: tool.name, description: tool.description }));
    } catch (error) {
      throw mapClientError(error, "tools/list");
    }
  }

  async close(): Promise<void> {
    await this.#client?.close().catch(() => undefined);
    await this.#transport?.close().catch(() => undefined);
    this.#client = undefined;
    this.#transport = undefined;
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    const session: PersistedSession = await this.#options.store.load();
    if (session.serverUrl && session.serverUrl !== this.#options.serverUrl) {
      this.#options.log?.(
        `warning: session was created for ${session.serverUrl} but the CLI targets ${this.#options.serverUrl}`,
      );
    }
    const provider = new PersistentOAuthClientProvider({
      session,
      onSave: (next) => this.#options.store.save(next),
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.#options.serverUrl), {
      authProvider: provider,
      fetch: this.#options.fetchImpl,
    });
    const client = new Client(
      { name: "unicas-cli", version: UNICAS_CLI_VERSION },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (error) {
      throw mapClientError(error, "initialize");
    }
    this.#client = client;
    this.#transport = transport;
    return client;
  }
}

function normalizeToolResult(result: unknown): ToolCallResult {
  if (typeof result !== "object" || result === null) {
    return { structuredContent: {}, text: null, isError: false };
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const textBlock = content.find(
    (block): block is { type: string; text?: unknown } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  const text = typeof textBlock?.text === "string" ? textBlock.text : null;
  const structured = record.structuredContent;
  const structuredContent = typeof structured === "object" && structured !== null
    ? structured as Record<string, unknown>
    : text
      ? parseJsonObject(text)
      : {};
  return {
    structuredContent,
    text,
    isError: record.isError === true,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapClientError(error: unknown, operation: string): Error {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "NeedsLoginError") {
    return new CliError(error.message, 2);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(`MCP call '${operation}' failed: ${message}`, 1);
}
