/**
 * transport 是 client 与「怎么把请求送出去」之间的唯一接缝。
 * client 自己不含 fetch，也不知道假后端存在。
 */
import type { TenantApiError } from "@unidocs/protocol-tenant-portal";

export type QueryValue = string | number | boolean | undefined;

export interface PlatformRequest {
  readonly method: "GET" | "POST";
  /** 已拼好的完整路径，含 tenantId，形如 /api/v1/tenants/t1/documents。 */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** 存在时由 transport 落到 idempotency-key 请求头。 */
  readonly idempotencyKey?: string;
  /**
   * "cbor" 表示调用方要的是原始字节（目前只有 getVersionSnapshot 用，响应是
   * canonical SValue CBOR）；省略等价于 "json"。transport 据此决定是解析 JSON
   * 还是把响应体整段读成 bytes。
   */
  readonly accept?: "json" | "cbor";
}

export type PlatformResponse =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: TenantApiError };

export type PlatformTransport = (request: PlatformRequest) => Promise<PlatformResponse>;
