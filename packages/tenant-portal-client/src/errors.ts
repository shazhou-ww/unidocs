/**
 * Tenant API 错误的客户端表示。调用方按 `code` 分支，不解析 `message`。
 */
import type { JsonValue } from "@unidocs/protocol";
import { TenantApiErrorMap, type TenantApiError } from "@unidocs/protocol-tenant-portal";

/**
 * 已知错误码，从 TenantApiErrorMap 的 key 派生（那些 key 是
 * UPPER_SNAKE_CASE 的 oRPC 错误标识；线上 `code` 字段实际是 lower_snake_case），
 * 或服务端先行引入的未知码。
 */
export type PlatformErrorCode = Lowercase<keyof typeof TenantApiErrorMap>;
export type PlatformErrorCodeOrUnknown = PlatformErrorCode | (string & {});

export class PlatformError extends Error {
  readonly code: PlatformErrorCodeOrUnknown;
  readonly requestId: string;
  readonly details: JsonValue | null;

  constructor(options: {
    code: PlatformErrorCodeOrUnknown;
    message: string;
    requestId: string;
    details?: JsonValue;
  }) {
    super(options.message);
    this.name = "PlatformError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details ?? null;
  }
}

export function toPlatformError(payload: TenantApiError): PlatformError {
  return new PlatformError({
    code: payload.error.code,
    message: payload.error.message,
    requestId: payload.error.requestId,
    details: payload.error.details,
  });
}
