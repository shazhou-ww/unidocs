/**
 * `/admin` BFF entry. Task 1 scaffolds the deployable package boundary;
 * Task 2 implements Google OIDC, sessions, CSRF, and handlers.
 */
export const CAS_ADMIN_WEBUI_MOUNT = "/admin" as const;

export default {
  async fetch(): Promise<Response> {
    return new Response("CAS admin BFF not implemented", { status: 501 });
  },
};
