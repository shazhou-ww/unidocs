export type GatewayOAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_response_type"
  | "unsupported_grant_type"
  | "server_error";

export class GatewayOAuthProtocolError extends Error {
  readonly code: GatewayOAuthErrorCode;
  readonly status: 400 | 401 | 403 | 500;
  readonly description?: string;

  constructor(
    code: GatewayOAuthErrorCode,
    status: 400 | 401 | 403 | 500,
    description?: string,
  ) {
    super(description ?? code);
    this.name = "GatewayOAuthProtocolError";
    this.code = code;
    this.status = status;
    this.description = description;
  }

  toResponse(): Response {
    return Response.json({
      error: this.code,
      ...(this.description ? { error_description: this.description } : {}),
    }, {
      status: this.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
