import {
  gatewayOAuthMetadataPath,
  gatewayOpenIdConfigurationPath,
  renderGatewayOAuthMetadata,
} from "./metadata.js";
import type {
  GatewayOAuthAuthorizationServerMetadata,
  GatewayOAuthServerMetadataConfig,
} from "./metadata.js";
import { renderGatewayOAuthJwks } from "./jwks.js";
import type { GatewayOAuthSigningKeySetPort } from "./jwks.js";

export interface GatewayOAuthDiscoveryHandlerConfig {
  readonly metadata: GatewayOAuthServerMetadataConfig;
  readonly signingKeys: GatewayOAuthSigningKeySetPort;
  readonly enableOpenIdConfiguration?: boolean;
  readonly cacheControl?: string;
}

export type GatewayOAuthDiscoveryHandler = (request: Request) => Promise<Response | null>;

export function createGatewayOAuthDiscoveryHandler(
  config: GatewayOAuthDiscoveryHandlerConfig,
): GatewayOAuthDiscoveryHandler {
  const metadata = renderGatewayOAuthMetadata(config.metadata);
  const metadataPaths = new Set([gatewayOAuthMetadataPath(metadata.issuer)]);
  if (config.enableOpenIdConfiguration) {
    metadataPaths.add(gatewayOpenIdConfigurationPath(metadata.issuer));
  }
  const jwksPath = new URL(metadata.jwks_uri).pathname;
  const cacheControl = config.cacheControl ?? "public, max-age=300";

  return async request => {
    const url = new URL(request.url);
    const isMetadata = metadataPaths.has(url.pathname);
    const isJwks = url.pathname === jwksPath;
    if (!isMetadata && !isJwks) return null;
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    }
    if (isMetadata) return jsonDiscoveryResponse(metadata, cacheControl);
    const keys = await config.signingKeys.publicSigningKeys();
    return jsonDiscoveryResponse(renderGatewayOAuthJwks(keys), cacheControl);
  };
}

function jsonDiscoveryResponse(
  value: GatewayOAuthAuthorizationServerMetadata | ReturnType<typeof renderGatewayOAuthJwks>,
  cacheControl: string,
): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
