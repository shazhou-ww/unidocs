import {
  isAdminMcpBase64Zip,
  type AdministratorMemberRecord,
  type AdminMcpToolInput,
  type DocumentTypeRegistration,
} from "@unidocs/protocol-admin-portal";
import { normalizeAdministratorEmail } from "../auth/administrator.js";

export class AdminMcpInputError extends Error {
  constructor(readonly code: "invalid_request" | "precondition_failed") {
    super(code === "precondition_failed"
      ? "The resource changed. Get it again and explicitly decide whether to retry."
      : "The MCP tool input or confirmation is invalid");
    this.name = "AdminMcpInputError";
  }
}

export function requireAdminMcpRemovalConfirmation(
  input: AdminMcpToolInput<"remove_administrator">,
  current: AdministratorMemberRecord,
): void {
  if (input.etag !== current.etag) throw new AdminMcpInputError("precondition_failed");
  if (input.adminId !== current.adminId || input.confirmAdminId !== current.adminId) throw new AdminMcpInputError("invalid_request");
  try {
    if (normalizeAdministratorEmail(input.confirmEmail) !== normalizeAdministratorEmail(current.email)) throw new Error();
  } catch {
    throw new AdminMcpInputError("invalid_request");
  }
}

export function requireAdminMcpDocumentTypeConfirmation(
  input: AdminMcpToolInput<"update_document_type">,
  current: DocumentTypeRegistration,
): void {
  if (input.etag !== current.etag) throw new AdminMcpInputError("precondition_failed");
  if (input.documentType !== current.documentType
    || (input.enabled !== undefined && input.confirmEnabled !== input.enabled)
    || (input.builtinOperatorId === null && (!current.builtinOperator || input.confirmOperatorId !== current.builtinOperator.operatorId))
    || ([input.typeCardBundleId, input.viewBundleId, input.builtinOperatorId].some(value => value !== undefined) && !input.reason?.trim())) {
    throw new AdminMcpInputError("invalid_request");
  }
}

export function adminMcpZipStream(value: string): ReadableStream<Uint8Array> {
  if (!isAdminMcpBase64Zip(value)) throw new AdminMcpInputError("invalid_request");
  let encoded = value;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = atob(encoded.slice(offset, offset + 64 * 1024));
      offset += 64 * 1024;
      controller.enqueue(Uint8Array.from(chunk, character => character.charCodeAt(0)));
      if (offset >= encoded.length) {
        encoded = "";
        controller.close();
      }
    },
    cancel() { encoded = ""; },
  }, { highWaterMark: 0 });
}