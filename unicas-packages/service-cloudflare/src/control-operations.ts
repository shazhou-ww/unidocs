import { ControlPlaneService } from "@unicas/control-plane";
import {
  ControlPlaneAdminService,
  type ControlPlaneOperations,
} from "@unicas/service";
import { D1ControlPlaneAdminRepository } from "./control-admin-repository.js";

/** Compose extracted cloud-neutral semantics with the explicitly retained legacy slice. */
export function createControlPlaneOperations(
  db: D1Database,
  options: { readonly now?: () => number } = {},
): ControlPlaneOperations {
  const admin = new ControlPlaneAdminService(
    new D1ControlPlaneAdminRepository(db),
    options,
  );
  const legacy = new ControlPlaneService(db, options);

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
    getIssuer: legacy.getIssuer.bind(legacy),
    putIssuer: legacy.putIssuer.bind(legacy),
    createPossessionChallenge: legacy.createPossessionChallenge.bind(legacy),
    listIssuerKeys: legacy.listIssuerKeys.bind(legacy),
    createIssuerKey: legacy.createIssuerKey.bind(legacy),
    deleteIssuerKey: legacy.deleteIssuerKey.bind(legacy),
    listControlAuditEvents: legacy.listControlAuditEvents.bind(legacy),
    recordSessionAudit: admin.recordSessionAudit.bind(admin),
  };
}
