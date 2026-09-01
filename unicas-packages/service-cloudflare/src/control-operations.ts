import {
  ControlPlaneAdminService,
  type ControlPlaneOperations,
  type OAuthDiscoveryPort,
} from "@unicas/service";
import { D1ControlPlaneAdminRepository } from "./control-admin-repository.js";

/** Compose the cloud-neutral control semantics over the D1 storage adapter. */
export function createControlPlaneOperations(
  db: D1Database,
  options: {
    readonly now?: () => number;
    readonly oauthDiscovery?: OAuthDiscoveryPort;
  } = {},
): ControlPlaneOperations {
  const admin = new ControlPlaneAdminService(
    new D1ControlPlaneAdminRepository(db),
    { now: options.now, oauthDiscovery: options.oauthDiscovery },
  );

  return {
    me: admin.me.bind(admin),
    listStacks: admin.listStacks.bind(admin),
    createStack: admin.createStack.bind(admin),
    getStack: admin.getStack.bind(admin),
    patchStack: admin.patchStack.bind(admin),
    listMembers: admin.listMembers.bind(admin),
    deleteMember: admin.deleteMember.bind(admin),
    createMemberInvitation: admin.createMemberInvitation.bind(admin),
    acceptMemberInvitation: admin.acceptMemberInvitation.bind(admin),
    getIssuer: admin.getIssuer.bind(admin),
    getOAuthIssuer: admin.getOAuthIssuer.bind(admin),
    inspectOAuthIssuer: admin.inspectOAuthIssuer.bind(admin),
    activateOAuthIssuer: admin.activateOAuthIssuer.bind(admin),
    putIssuer: admin.putIssuer.bind(admin),
    createPossessionChallenge: admin.createPossessionChallenge.bind(admin),
    listIssuerKeys: admin.listIssuerKeys.bind(admin),
    createIssuerKey: admin.createIssuerKey.bind(admin),
    deleteIssuerKey: admin.deleteIssuerKey.bind(admin),
    listControlAuditEvents: admin.listControlAuditEvents.bind(admin),
    recordSessionAudit: admin.recordSessionAudit.bind(admin),
  };
}
