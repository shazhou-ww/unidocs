/**
 * Platform API 错误的客户端表示。调用方按 `code` 分支，不解析 `message`。
 */
import type { ApiError, JsonValue, PlatformErrorCode } from "@unidocs/protocol-platform";

/** 已知错误码，或服务端先行引入的未知码。 */
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

export function toPlatformError(payload: ApiError): PlatformError {
  return new PlatformError({
    code: payload.error.code,
    message: payload.error.message,
    requestId: payload.error.requestId,
    details: payload.error.details,
  });
}
