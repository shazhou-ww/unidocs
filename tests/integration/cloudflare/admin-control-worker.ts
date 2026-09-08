export { UniDocsAdminControl } from "../../../packages/cloudflare-gateway/src/admin-control-do.js";
export default {
  fetch(request: Request, env: { CONTROL: DurableObjectNamespace }): Promise<Response> {
    return env.CONTROL.get(env.CONTROL.idFromName("management")).fetch(request);
  },
};