import { McpServer } from "@modelcontextprotocol/server";
import { AdminMcpInputSchemas } from "@unidocs/protocol-admin-portal";
import {
  ADMIN_MCP_CATALOG, adminMcpZipStream, requireAdminMcpDocumentTypeConfirmation, requireAdminMcpRemovalConfirmation, resolveAdminMcpContext,
  type AdminContext, type AdminMcpMember, type AdminMcpPolicy, type AdminMcpToolName, type VerifiedAdminMcpGrant,
  type createAdministratorService, type createAuditEventService, type createDocumentContractService, type createDocumentTypeService,
  type createOperatorService, type createOperatorValidationService, type createTypeCardBundleService, type createViewBundleService,
} from "@unidocs/portal-service";

const readOnlyPolicy = { enabled: true, contentMutationsEnabled: false, publishMutationsEnabled: false, securityMutationsEnabled: false } as const;

export function createAdminMcpServer(options: {
  readonly grant: VerifiedAdminMcpGrant;
  readonly allowedEmails: readonly string[];
  readonly findMember: (memberId: string) => Promise<AdminMcpMember | null>;
  readonly services?: AdminMcpReadServices;
  readonly policy?: AdminMcpPolicy;
  readonly now?: () => number;
}): McpServer {
  const server = new McpServer({ name: "unidocs-admin", version: "0.1.0" });
  const policy = options.policy ?? readOnlyPolicy;
  const context = (toolName: AdminMcpToolName) => resolveAdminMcpContext({
    verifiedGrant: options.grant, toolName, policy, allowedEmails: options.allowedEmails,
    now: (options.now ?? (() => Math.floor(Date.now() / 1000)))(), findMember: options.findMember,
  });
  const run = async (toolName: AdminMcpToolName, operation: (admin: AdminContext) => Promise<unknown>) => {
    try {
      const result = await operation(await context(toolName));
      const structuredContent = objectResult(result);
      return { content: [{ type: "text" as const, text: `${toolName} completed` }], structuredContent };
    } catch (error) {
      const code = errorCode(error);
      return { isError: true, content: [{ type: "text" as const, text: `Admin MCP request failed: ${code}` }], structuredContent: { error: { code } } };
    }
  };
  server.registerTool("whoami", {
    title: "Current UniDocs administrator",
    description: "Return the authenticated administrator and granted Admin MCP scopes.",
    inputSchema: AdminMcpInputSchemas.whoami,
    annotations: ADMIN_MCP_CATALOG.whoami.annotations,
  }, async () => {
    return run("whoami", async admin => ({
      memberId: admin.memberId,
      identity: { issuer: admin.identity.issuer, subject: admin.identity.subject, email: admin.identity.email },
      scopes: [...options.grant.scopes],
      oauthClientHandle: admin.caller?.channel === "mcp" ? admin.caller.oauthClientHandle : undefined,
    }));
  });
  if (!options.services) return server;
  const services = options.services;
  server.registerTool("list_document_types", definition("List document types", "List registered document types.", "list_document_types"), input => run("list_document_types", admin => services.documentTypes.list(admin, input)));
  server.registerTool("get_document_type", definition("Get document type", "Get one document type registration and ETag.", "get_document_type"), input => run("get_document_type", admin => services.documentTypes.get(admin, input.documentType)));
  server.registerTool("list_document_contracts", definition("List document contracts", "List contract revisions for a document type.", "list_document_contracts"), input => run("list_document_contracts", admin => {
    const { documentType, ...query } = input;
    return services.documentContracts.list(admin, documentType, query);
  }));
  server.registerTool("get_document_contract", definition("Get document contract", "Get one document contract revision.", "get_document_contract"), input => run("get_document_contract", admin => services.documentContracts.get(admin, input.documentType, input.documentContractIdx)));
  server.registerTool("list_type_card_bundles", definition("List Type Card bundles", "List uploaded Type Card candidates.", "list_type_card_bundles"), input => run("list_type_card_bundles", admin => services.typeCardBundles.list(admin, input)));
  server.registerTool("get_type_card_bundle", definition("Get Type Card bundle", "Get one Type Card candidate and ETag.", "get_type_card_bundle"), input => run("get_type_card_bundle", admin => services.typeCardBundles.get(admin, input.typeCardBundleId)));
  server.registerTool("list_view_bundles", definition("List View bundles", "List uploaded View candidates.", "list_view_bundles"), input => run("list_view_bundles", admin => services.viewBundles.list(admin, input)));
  server.registerTool("get_view_bundle", definition("Get View bundle", "Get one View candidate and ETag.", "get_view_bundle"), input => run("get_view_bundle", admin => services.viewBundles.get(admin, input.viewBundleId)));
  server.registerTool("get_operator_validation", definition("Get Operator validation", "Get one unexpired Operator validation.", "get_operator_validation"), input => run("get_operator_validation", admin => services.operatorValidations.get(admin, input.validationId)));
  server.registerTool("list_operators", definition("List Operators", "List registered Operator candidates.", "list_operators"), input => run("list_operators", admin => services.operators.list(admin, input)));
  server.registerTool("get_operator", definition("Get Operator", "Get one Operator candidate and ETag.", "get_operator"), input => run("get_operator", admin => services.operators.get(admin, input.operatorId)));
  server.registerTool("list_administrators", definition("List administrators", "List UniDocs administrators.", "list_administrators"), input => run("list_administrators", admin => services.administrators.list(admin, input)));
  server.registerTool("get_administrator", definition("Get administrator", "Get one UniDocs administrator and ETag.", "get_administrator"), input => run("get_administrator", admin => services.administrators.get(admin, input.adminId)));
  server.registerTool("list_admin_audit_events", definition("List admin audit events", "List administrator mutation audit events.", "list_admin_audit_events"), input => run("list_admin_audit_events", admin => services.auditEvents.list(admin, input)));
  if (policy.contentMutationsEnabled && services.documentContracts.append) {
    server.registerTool("append_document_contract", definition("Append document contract", "Append the next immutable contract revision for a document type.", "append_document_contract"), input => run("append_document_contract", admin => {
      const { documentType, idempotencyKey, ...body } = input;
      return services.documentContracts.append!(admin, documentType, body, idempotencyKey, crypto.randomUUID());
    }));
  }
  if (policy.contentMutationsEnabled && services.typeCardBundles?.upload && services.typeCardBundles.updateMetadata
    && services.viewBundles?.upload && services.viewBundles.updateMetadata && services.operatorValidations?.validate
    && services.operators?.create && services.operators.updateMetadata) {
    server.registerTool("upload_type_card_bundle", definition("Upload Type Card bundle", "Upload a base64 ZIP as a Type Card candidate.", "upload_type_card_bundle"), input => run("upload_type_card_bundle", admin => {
      const { idempotencyKey, base64Zip, ...query } = input;
      return services.typeCardBundles.upload!(admin, query, adminMcpZipStream(base64Zip), idempotencyKey, crypto.randomUUID());
    }));
    server.registerTool("update_type_card_bundle_metadata", definition("Update Type Card metadata", "Replace a Type Card candidate name and description using its current ETag.", "update_type_card_bundle_metadata"), input => run("update_type_card_bundle_metadata", admin => {
      const { typeCardBundleId, idempotencyKey, etag, ...body } = input;
      return services.typeCardBundles.updateMetadata!(admin, typeCardBundleId, body, idempotencyKey, etag, crypto.randomUUID());
    }));
    server.registerTool("upload_view_bundle", definition("Upload View bundle", "Upload a base64 ZIP as a View candidate.", "upload_view_bundle"), input => run("upload_view_bundle", admin => {
      const { idempotencyKey, base64Zip, ...query } = input;
      return services.viewBundles.upload!(admin, query, adminMcpZipStream(base64Zip), idempotencyKey, crypto.randomUUID());
    }));
    server.registerTool("update_view_bundle_metadata", definition("Update View metadata", "Replace a View candidate name and description using its current ETag.", "update_view_bundle_metadata"), input => run("update_view_bundle_metadata", admin => {
      const { viewBundleId, idempotencyKey, etag, ...body } = input;
      return services.viewBundles.updateMetadata!(admin, viewBundleId, body, idempotencyKey, etag, crypto.randomUUID());
    }));
    server.registerTool("create_operator_validation", definition("Validate Operator", "Discover and probe the deployed first-party Operator candidate.", "create_operator_validation"), input => run("create_operator_validation", admin => {
      const { idempotencyKey, ...body } = input;
      return services.operatorValidations.validate!(admin, body, idempotencyKey, crypto.randomUUID());
    }));
    server.registerTool("create_operator", definition("Create Operator", "Persist a candidate from a current successful validation.", "create_operator"), input => run("create_operator", admin => {
      const { idempotencyKey, ...body } = input;
      return services.operators.create!(admin, body, idempotencyKey, crypto.randomUUID());
    }));
    server.registerTool("update_operator_metadata", definition("Update Operator metadata", "Replace an Operator candidate name and description using its current ETag.", "update_operator_metadata"), input => run("update_operator_metadata", admin => {
      const { operatorId, idempotencyKey, etag, ...body } = input;
      return services.operators.updateMetadata!(admin, operatorId, body, idempotencyKey, etag, crypto.randomUUID());
    }));
  }
  if (policy.publishMutationsEnabled && services.documentTypes.create) {
    server.registerTool("create_document_type", definition("Create document type", "Create a new disabled document type draft.", "create_document_type"), input => run("create_document_type", admin => {
      const { idempotencyKey, ...body } = input;
      return services.documentTypes.create!(admin, body, idempotencyKey, crypto.randomUUID());
    }));
  }
  if (policy.publishMutationsEnabled && services.documentTypes.update && services.documentTypes.replayUpdate) {
    server.registerTool("update_document_type", definition("Update document type", "Update a document type registration using its current ETag and explicit confirmations.", "update_document_type"), input => run("update_document_type", async admin => {
      const { documentType, idempotencyKey, etag, confirmEnabled: _confirmEnabled, confirmOperatorId: _confirmOperatorId, ...body } = input;
      const replay = await services.documentTypes.replayUpdate!(admin, documentType, body, idempotencyKey, etag);
      if (replay) return replay;
      requireAdminMcpDocumentTypeConfirmation(input, await services.documentTypes.get(admin, documentType));
      return services.documentTypes.update!(admin, documentType, body, idempotencyKey, etag, crypto.randomUUID());
    }));
  }
  if (policy.securityMutationsEnabled && services.administrators.add) {
    server.registerTool("add_administrator", definition("Add administrator", "Invite a Google account as a UniDocs administrator.", "add_administrator"), input => run("add_administrator", admin => {
      const { idempotencyKey, confirmEmail: _confirmEmail, ...body } = input;
      return services.administrators.add!(admin, body, idempotencyKey, crypto.randomUUID());
    }));
  }
  if (policy.securityMutationsEnabled && services.administrators.remove && services.administrators.replayRemove) {
    server.registerTool("remove_administrator", definition("Remove administrator", "Remove an administrator using its current ETag and explicit identity confirmations.", "remove_administrator"), input => run("remove_administrator", async admin => {
      const { adminId, idempotencyKey, etag, confirmAdminId: _confirmAdminId, confirmEmail: _confirmEmail } = input;
      if (await services.administrators.replayRemove!(admin, adminId, idempotencyKey, etag)) return { adminId };
      requireAdminMcpRemovalConfirmation(input, await services.administrators.get(admin, adminId));
      await services.administrators.remove!(admin, adminId, idempotencyKey, etag, crypto.randomUUID());
      return { adminId };
    }));
  }
  return server;
}

export interface AdminMcpReadServices {
  readonly documentTypes: Pick<ReturnType<typeof createDocumentTypeService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createDocumentTypeService>, "create" | "replayUpdate" | "update">>;
  readonly documentContracts: Pick<ReturnType<typeof createDocumentContractService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createDocumentContractService>, "append">>;
  readonly typeCardBundles: Pick<ReturnType<typeof createTypeCardBundleService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createTypeCardBundleService>, "upload" | "updateMetadata">>;
  readonly viewBundles: Pick<ReturnType<typeof createViewBundleService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createViewBundleService>, "upload" | "updateMetadata">>;
  readonly operatorValidations: Pick<ReturnType<typeof createOperatorValidationService>, "get"> & Partial<Pick<ReturnType<typeof createOperatorValidationService>, "validate">>;
  readonly operators: Pick<ReturnType<typeof createOperatorService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createOperatorService>, "create" | "updateMetadata">>;
  readonly administrators: Pick<ReturnType<typeof createAdministratorService>, "get" | "list"> & Partial<Pick<ReturnType<typeof createAdministratorService>, "add" | "replayRemove" | "remove">>;
  readonly auditEvents: Pick<ReturnType<typeof createAuditEventService>, "list">;
}

function definition<Name extends keyof typeof AdminMcpInputSchemas>(title: string, description: string, name: Name) {
  return { title, description, inputSchema: AdminMcpInputSchemas[name], annotations: ADMIN_MCP_CATALOG[name].annotations };
}

function objectResult(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (["invalid_request", "not_found", "forbidden", "precondition_failed", "idempotency_conflict", "operator_validation_required", "operator_validation_failed", "administrator_exists", "cannot_remove_self", "last_administrator"].includes(String(code))) return String(code);
  }
  return "internal_error";
}