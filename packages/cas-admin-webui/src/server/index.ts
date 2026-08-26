/**
 * `/admin` BFF Worker entry. Wires bindings into the testable `createAdminBff`
 * and runs CAS_CONTROL_DB migrations at startup.
 *
 * Secret material (Google client credentials, session encryption keys) is read
 * only here and never reaches browser code. This Worker has no binding to
 * tenant D1/R2/DO and does not import tenant worker/DO implementation modules.
 */

import { migrateControlSchema } from "@unidocs/cas-control-plane";
import { createAdminBff } from "./bff.js";
import { configFromEnv } from "./config.js";
import type { AdminBffEnv } from "./config.js";

export { createAdminBff } from "./bff.js";
export { configFromEnv } from "./config.js";
export { OidcClient } from "./oidc.js";
export { SessionCrypto } from "./session.js";

export interface Env extends AdminBffEnv {
  CAS_CONTROL_DB: D1Database;
  /** Private tenant audit-reader service binding (Task 7+). */
  CAS_TENANT_AUDIT_READER?: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = configFromEnv(env);
    await migrateControlSchema(env.CAS_CONTROL_DB);
    const adminFetch = createAdminBff({
      config,
      db: env.CAS_CONTROL_DB,
      auditReader: env.CAS_TENANT_AUDIT_READER,
    });
    return adminFetch(request);
  },
};
