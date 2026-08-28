import type { CasReferences, SValue } from "@unidocs/protocol";
import { refsFromSValue } from "@unidocs/svalue-codec";

export interface CasLeaseGateway {
  leaseNode(hash: string): Promise<unknown>;
}

export interface CasRootRefGateway {
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<unknown>;
}

export function aggregateRefs(operations: readonly SValue[]): CasReferences {
  return refsFromSValue(operations as SValue);
}

export async function leaseOpRefs(
  operations: readonly SValue[],
  cas: CasLeaseGateway,
): Promise<CasReferences> {
  const refs = aggregateRefs(operations);
  for (const hash of Object.keys(refs)) await cas.leaseNode(hash);
  return refs;
}

export async function commitRootRefsOrRollback(
  cas: CasRootRefGateway,
  requestId: string,
  changes: CasReferences,
  rollback: () => void | Promise<void>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  try {
    await cas.updateRootRefs({ requestId, changes });
  } catch (error) {
    await rollback();
    throw error;
  }
}