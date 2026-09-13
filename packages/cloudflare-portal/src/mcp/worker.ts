import { createMcpHandler } from "agents/mcp/server";
import type { VerifiedAdminMcpGrant } from "@unidocs/portal-service";
import {
  createAdministratorService, createAuditEventService, createDocumentContractService, createDocumentTypeService,
  createOperatorService, createOperatorValidationService, createTypeCardBundleService, createViewBundleService,
} from "@unidocs/portal-service";
import { createAdminMcpServer, type AdminMcpReadServices } from "./server.js";
import { D1AdminMcpMembers } from "./members.js";
import type { AdminMcpOAuthEnv } from "./oauth.js";
import { D1DocumentTypeRepository } from "../document-types-repository.js";
import { D1DocumentContractRepository } from "../document-contracts-repository.js";
import { D1TypeCardBundleRepository } from "../type-card-bundles-repository.js";
import { D1ViewBundleRepository } from "../view-bundles-repository.js";
import { D1OperatorValidationRepository } from "../operator-validations-repository.js";
import { D1OperatorRepository } from "../operators-repository.js";
import { D1AdministratorRepository } from "../administrators-repository.js";
import { D1AuditEventRepository } from "../audit-events-repository.js";
import { R2BundleObjectStore } from "../bundle-object-store.js";
import { createMarkdownOperatorValidationTarget } from "../operator-validation-target.js";

const verifiedOAuthContext = Symbol.for("cloudflare.workers-oauth-provider.verified-context.v1");

interface AdminMcpRuntimeEnv extends AdminMcpOAuthEnv {
  BUNDLES: R2Bucket;
  BUNDLE_ORIGIN: string;
  ADMIN_MARKDOWN_SERVICE: Fetcher;
  MARKDOWN_OPERATOR_HMAC_KEY: string;
}

export async function handleAdminMcp(request: Request, env: AdminMcpRuntimeEnv, context: ExecutionContext, grant: VerifiedAdminMcpGrant, options: {
  readonly publicOrigin: string;
  readonly allowedEmails: readonly string[];
  readonly services?: AdminMcpReadServices;
  readonly now?: () => number;
}): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return Response.json({ error: "invalid_token" }, { status: 401 });
  const target = context as ExecutionContext & Record<PropertyKey, unknown> & { props?: Record<string, unknown> };
  let authProps: Record<string, unknown>;
  if (!(verifiedOAuthContext in target)) {
    authProps = { memberId: grant.memberId, identity: grant.identity, clientId: grant.clientId, scopes: [...grant.scopes] };
    target.props = authProps;
    target[verifiedOAuthContext] = { version: 1, token, clientId: grant.clientId, scopes: [...grant.scopes], resource: `${options.publicOrigin}/mcp`, props: authProps };
  } else {
    if (typeof target.props !== "object" || target.props === null || Array.isArray(target.props)) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    authProps = target.props;
  }
  const members = new D1AdminMcpMembers(env.DB);
  const objectStore = options.services ? null : new R2BundleObjectStore(env.BUNDLES);
  const operatorTarget = options.services ? null : createMarkdownOperatorValidationTarget(env.ADMIN_MARKDOWN_SERVICE, env.MARKDOWN_OPERATOR_HMAC_KEY);
  const services = options.services ?? {
    documentTypes: createDocumentTypeService(new D1DocumentTypeRepository(env.DB)),
    documentContracts: createDocumentContractService(new D1DocumentContractRepository(env.DB)),
    typeCardBundles: createTypeCardBundleService(new D1TypeCardBundleRepository(env.DB), objectStore!, { bundleOrigin: env.BUNDLE_ORIGIN }),
    viewBundles: createViewBundleService(new D1ViewBundleRepository(env.DB), objectStore!, { bundleOrigin: env.BUNDLE_ORIGIN }),
    operatorValidations: createOperatorValidationService(new D1OperatorValidationRepository(env.DB), operatorTarget!.transport, operatorTarget!.keys),
    operators: createOperatorService(new D1OperatorRepository(env.DB)),
    administrators: createAdministratorService(new D1AdministratorRepository(env.DB)),
    auditEvents: createAuditEventService(new D1AuditEventRepository(env.DB)),
  };
  const handler = createMcpHandler(() => createAdminMcpServer({
    grant, allowedEmails: options.allowedEmails, findMember: memberId => members.findById(memberId), now: options.now,
    services,
  }), { route: "/mcp", allowedOriginHostnames: [new URL(options.publicOrigin).hostname], authContext: { props: authProps } });
  return handler(request, env, context);
}