import { markdownDiscovery, type MarkdownDiscoveryBindings } from "../../../packages/cloudflare-markdown/src/discovery.js";

export default {
  fetch(request: Request, env: MarkdownDiscoveryBindings): Response {
    return markdownDiscovery(request, env) ?? new Response("Not found", { status: 404 });
  },
};