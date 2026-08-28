/**
 * `unicas mcp`: a stdio MCP server exposing the same 18-tool contract as the
 * remote control-plane MCP server, forwarding each tool call over the
 * authenticated Streamable HTTP connection.
 *
 * This is what DSH (DeepSeek Harness) or any stdio-capable MCP client
 * launches with `command: "unicas", args: ["mcp"]`. Only MCP protocol frames
 * are written to stdout; all diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "./catalog.js";
import { TOOL_CATALOG } from "./catalog.js";
import { UnicasRemoteClient } from "../remote/client.js";
import type { TokenStore } from "../store.js";

export interface McpStdioServerOptions {
  readonly serverUrl: string;
  readonly store: TokenStore;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Diagnostic log sink; defaults to stderr. */
  readonly log?: (message: string) => void;
  /** Test-only: inject a custom transport instead of stdio. */
  readonly transport?: Transport;
}

export async function runMcpStdioServer(options: McpStdioServerOptions): Promise<void> {
  const server = new McpServer({
    name: "unicas-control-plane-cli",
    version: "0.1.0",
  });

  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const holder: { remote?: UnicasRemoteClient } = {};
  const getOrCreateRemote = (): UnicasRemoteClient => {
    holder.remote ??= new UnicasRemoteClient({
      serverUrl: options.serverUrl,
      store: options.store,
      fetchImpl: options.fetchImpl,
      log,
    });
    return holder.remote;
  };

  for (const tool of TOOL_CATALOG) {
    registerCatalogTool(server, tool, getOrCreateRemote);
  }

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
}

function registerCatalogTool(
  server: McpServer,
  tool: ToolDefinition,
  getOrCreateRemote: () => UnicasRemoteClient,
): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const remote = getOrCreateRemote();
        const result = await remote.callTool(tool.name, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
          structuredContent: result.structuredContent,
          isError: result.isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structuredContent = { error: "CLIENT_ERROR", message };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError: true,
        };
      }
    },
  );
}
