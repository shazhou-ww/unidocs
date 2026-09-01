/**
 * `unicas mcp`: a stdio MCP server exposing the same tool contract as the
 * remote control-plane MCP server, backed by the local `/admin` HTTP client
 * (the authenticated session from `unicas login`). No MCP-to-MCP forwarding.
 *
 * This is what DSH (DeepSeek Harness) or any stdio-capable MCP client
 * launches with `command: "unicas", args: ["mcp"]`. Only MCP protocol frames
 * are written to stdout; all diagnostics go to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AdminClient } from "@unicas/admin-client";
import { createAdminClient } from "@unicas/admin-client";
import type { ToolDefinition } from "./catalog.js";
import { TOOL_CATALOG } from "./catalog.js";
import type { TokenStore } from "../store.js";

export interface McpStdioServerOptions {
  readonly adminOrigin: string;
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
  const holder: { admin?: AdminClient } = {};
  const getOrCreateAdmin = async (): Promise<AdminClient> => {
    if (holder.admin !== undefined) return holder.admin;
    const session = await options.store.load();
    if (session.cookie.length === 0 || session.csrfToken.length === 0) {
      throw new Error("Not logged in. Run `unicas login` first.");
    }
    holder.admin = createAdminClient({
      baseUrl: options.adminOrigin,
      getSession: async () => ({ cookie: session.cookie, csrfToken: session.csrfToken }),
      fetcher: options.fetchImpl,
    });
    return holder.admin;
  };

  for (const tool of TOOL_CATALOG) {
    registerCatalogTool(server, tool, getOrCreateAdmin, log);
  }

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
}

type ToolHandler = (admin: AdminClient, args: Record<string, unknown>) => Promise<unknown>;

function registerCatalogTool(
  server: McpServer,
  tool: ToolDefinition,
  getOrCreateAdmin: () => Promise<AdminClient>,
  log: (message: string) => void,
): void {
  const handler = TOOL_HANDLERS[tool.name];
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
      if (handler === undefined) {
        return toolError(`no local handler for tool '${tool.name}'`);
      }
      try {
        const admin = await getOrCreateAdmin();
        const result = await handler(admin, args);
        const structuredContent = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError: false,
        };
      } catch (error) {
        log(`unicas mcp: tool '${tool.name}' failed: ${error instanceof Error ? error.message : String(error)}`);
        const structuredContent = { error: "CLIENT_ERROR", message: error instanceof Error ? error.message : String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError: true,
        };
      }
    },
  );
}

function toolError(message: string): { content: { type: "text"; text: string }[]; structuredContent: { error: string; message: string }; isError: true } {
  const structuredContent = { error: "CLIENT_ERROR", message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

async function resolveEtag(
  admin: AdminClient,
  loader: () => Promise<{ etag: string }>,
  resource: string,
  provided: unknown,
): Promise<string> {
  if (typeof provided === "string" && provided.length > 0) return provided;
  const { etag } = await loader();
  if (etag.length === 0) throw new Error(`could not resolve the current ETag for ${resource}`);
  return etag;
}

/** Maps the remote tool contract to admin-client operations. */
const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  async whoami(admin) {
    return admin.me();
  },

  async list_stacks(admin, args) {
    return admin.listStacks(pick(args, ["limit", "cursor"]));
  },

  async get_stack(admin, args) {
    return (await admin.getStack({ stackId: str(args.stackId) })).value;
  },

  async create_stack(admin, args) {
    return admin.createStack(
      { displayName: str(args.displayName) },
      { idempotencyKey: args.idempotencyKey as string | undefined },
    );
  },

  async update_stack(admin, args) {
    const stackId = str(args.stackId);
    const etag = await resolveEtag(admin, () => admin.getStack({ stackId }), "stack", args.etag);
    const { value } = await admin.patchStack(
      { stackId },
      {
        ...(args.displayName !== undefined ? { displayName: str(args.displayName) } : {}),
        ...(args.description !== undefined ? { description: str(args.description) } : {}),
      },
      etag,
    );
    return value;
  },

  async list_members(admin, args) {
    return admin.listMembers({ stackId: str(args.stackId) }, pick(args, ["limit", "cursor"]));
  },

  async invite_member(admin, args) {
    requireMatch(args.confirmEmail, args.email, "confirmEmail must exactly match the invited email");
    return admin.createMemberInvitation(
      { stackId: str(args.stackId) },
      { emailConstraint: str(args.email) },
      { idempotencyKey: args.idempotencyKey as string | undefined },
    );
  },

  async remove_member(admin, args) {
    const stackId = str(args.stackId);
    const identityIssuer = str(args.identityIssuer);
    const subject = str(args.subject);
    requireMatch(args.confirmSubject, subject, "confirmSubject must exactly match subject");
    const etag = await resolveEtag(admin, () => admin.getStack({ stackId }), "stack", args.etag);
    return admin.deleteMember({ stackId }, { identityIssuer, subject }, etag);
  },

  async get_issuer(admin, args) {
    return (await admin.getIssuer({ stackId: str(args.stackId) })).value;
  },

  async get_oauth_issuer(admin, args) {
    const result = await admin.getOAuthIssuer({ stackId: str(args.stackId) });
    return { ...result.value, etag: result.etag };
  },

  async set_issuer(admin, args) {
    const stackId = str(args.stackId);
    requireMatch(args.confirmIssuer, args.issuer, "confirmIssuer must exactly match issuer");
    const etag = await resolveEtag(admin, () => admin.getIssuer({ stackId }), "issuer", args.etag);
    const { value } = await admin.putIssuer(
      { stackId },
      { issuer: str(args.issuer), audience: str(args.audience) },
      etag,
    );
    return value;
  },

  async inspect_oauth_issuer(admin, args) {
    const result = await admin.inspectOAuthIssuer(
      { stackId: str(args.stackId) },
      { issuer: str(args.issuer) },
    );
    return { ...result.value, etag: result.etag };
  },

  async activate_oauth_issuer(admin, args) {
    const stackId = str(args.stackId);
    const etag = await resolveEtag(admin, () => admin.getOAuthIssuer({ stackId }), "OAuth issuer", args.etag);
    const result = await admin.activateOAuthIssuer({ stackId }, {
      inspectionId: str(args.inspectionId),
      activationProof: str(args.activationProof),
    }, etag);
    return { ...result.value, etag: result.etag };
  },

  async list_issuer_keys(admin, args) {
    return admin.listIssuerKeys({ stackId: str(args.stackId) });
  },

  async create_issuer_key_challenge(admin, args) {
    return admin.createIssuerKeyChallenge({
      stackId: str(args.stackId),
      kid: str(args.kid),
      algorithm: str(args.algorithm),
    });
  },

  async add_issuer_key(admin, args) {
    const { value } = await admin.createIssuerKey(
      { stackId: str(args.stackId) },
      {
        kid: str(args.kid),
        algorithm: str(args.algorithm),
        publicJwk: args.publicJwk as Record<string, unknown>,
        possessionProof: str(args.possessionProof),
      },
      { idempotencyKey: args.idempotencyKey as string | undefined },
    );
    return value;
  },

  async transition_issuer_key(admin, args) {
    const stackId = str(args.stackId);
    const kid = str(args.kid);
    const state = args.state === "revoked" ? "revoked" as const : "retiring" as const;
    requireMatch(args.confirmKid, kid, "confirmKid must exactly match kid");
    requireMatch(args.confirmState, state, "confirmState must exactly match state");
    const etag = await resolveEtag(
      admin,
      async () => {
        const { keys } = await admin.listIssuerKeys({ stackId });
        const key = keys.find((entry) => entry.kid === kid);
        if (!key) throw new Error(`issuer key '${kid}' not found on stack '${stackId}'`);
        return { etag: `"${key.revision}"` };
      },
      `issuer key '${kid}'`,
      args.etag,
    );
    const { value } = await admin.deleteIssuerKey({ stackId, kid }, state, etag);
    return value;
  },

  async list_ref_domains(admin, args) {
    return admin.listRefDomains({ stackId: str(args.stackId) });
  },

  async list_control_audit_events(admin, args) {
    return admin.listControlAuditEvents({ stackId: str(args.stackId) }, pick(args, ["limit", "cursor"]));
  },

  async list_root_domain_refs(admin, args) {
    return admin.listRootDomainRefs(
      { stackId: str(args.stackId), refDomain: str(args.refDomain) },
      pick(args, ["tenantId", "limit", "cursor"]),
    );
  },

  async list_root_domain_events(admin, args) {
    return admin.listRootDomainEvents(
      { stackId: str(args.stackId), refDomain: str(args.refDomain) },
      pick(args, ["tenantId", "after", "limit"]),
    );
  },
};

function str(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireMatch(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}
