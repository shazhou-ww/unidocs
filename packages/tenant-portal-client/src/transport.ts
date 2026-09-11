/**
 * transport 是 client 与「怎么把请求送出去」之间的唯一接缝。
 * client 自己不含 fetch，也不知道假后端存在。
 */
import type { ApiError } from "@unidocs/protocol-platform";

export type QueryValue = string | number | boolean | undefined;

export interface PlatformRequest {
  readonly method: "GET" | "POST";
  /** 已拼好的完整路径，含 tenantId，形如 /api/v1/tenants/t1/documents。 */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** 存在时由 transport 落到 idempotency-key 请求头。 */
  readonly idempotencyKey?: string;
}

export type PlatformResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: ApiError };

export type PlatformTransport = (request: PlatformRequest) => Promise<PlatformResponse>;
