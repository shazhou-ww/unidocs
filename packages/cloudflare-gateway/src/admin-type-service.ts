import { AdminDirectory, AdminDirectoryError, AdminTypeDirectory, normalizeDocTypeBaseUrl } from "@unidocs/gateway-common";

export interface AdminTypeBindings {
  readonly ADMIN_MARKDOWN_SERVICE?: Fetcher;
  readonly ADMIN_MARKDOWN_BASE_URL?: string;
  readonly ADMIN_MARKDOWN_SERVICE_ID?: string;
  readonly ADMIN_MARKDOWN_STORAGE_IDENTITY?: string;
  readonly ADMIN_MARKDOWN_AUDIENCE?: string;
}

export function createAdminTypes(directory: AdminDirectory, env: AdminTypeBindings): AdminTypeDirectory {
  const values = [env.ADMIN_MARKDOWN_BASE_URL, env.ADMIN_MARKDOWN_SERVICE_ID, env.ADMIN_MARKDOWN_STORAGE_IDENTITY, env.ADMIN_MARKDOWN_AUDIENCE];
  if (!values.some(value => value !== undefined) && !env.ADMIN_MARKDOWN_SERVICE) return new AdminTypeDirectory(directory, []);
  if (!env.ADMIN_MARKDOWN_SERVICE || !values.every(value => typeof value === "string" && value.trim().length > 0)) throw new Error("Incomplete management type binding");
  const baseUrl = normalizeDocTypeBaseUrl(env.ADMIN_MARKDOWN_BASE_URL);
  const allowed = new Map([[new URL("./.well-known/unidocs-doctype", baseUrl).href, "GET"], [new URL("./health", baseUrl).href, "HEAD"], [new URL("./editor/", baseUrl).href, "HEAD"]]);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (allowed.get(url) !== (init?.method ?? "GET")) throw new AdminDirectoryError("url_not_approved", 422);
    const request = new Request(url, { method: init?.method ?? "GET", redirect: "manual", signal: init?.signal, headers: { Accept: url.endsWith("/editor/") ? "text/html" : "application/json" } });
    const response = await env.ADMIN_MARKDOWN_SERVICE!.fetch(request);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AdminDirectoryError("redirect_not_allowed", 422);
    }
    return response;
  };
  return new AdminTypeDirectory(directory, [{ baseUrl, docType: "markdown", serviceId: env.ADMIN_MARKDOWN_SERVICE_ID!, storageIdentity: env.ADMIN_MARKDOWN_STORAGE_IDENTITY!, audience: env.ADMIN_MARKDOWN_AUDIENCE! }], fetcher);
}