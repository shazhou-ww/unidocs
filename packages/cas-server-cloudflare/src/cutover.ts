/**
 * Durable cutover record and migration phase machine.
 *
 * Phases: `provisioned` (fresh stack-scoped schema) -> `migrating` (R2 copy +
 * `_legacy` baseline) -> `cutover` (legacy stack may fall back to stackless
 * keys) -> `contracted` (fallback disabled; other stacks may receive tenant
 * traffic). The marker is durable in `cas_schema_meta`; rollback moves the
 * marker back to `migrating` (never a schema downgrade). The stackless R2
 * fallback is restricted to the configured legacy stack and the non-contracted
 * window — a non-legacy stack must never probe a stackless key.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  readCutoverState,
  readLegacyStackId,
  writeCutoverState,
} from "./schema.js";
import type { CutoverState } from "./schema.js";

const TRANSITIONS: Readonly<Record<CutoverState, readonly CutoverState[]>> = {
  provisioned: ["migrating"],
  migrating: ["cutover", "provisioned"],
  cutover: ["contracted", "migrating"],
  contracted: [],
};

export function canTransitionCutover(from: CutoverState, to: CutoverState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function requireCutoverTransition(from: CutoverState, to: CutoverState): void {
  if (!canTransitionCutover(from, to)) {
    throw new Error(`Invalid cutover transition: ${from} -> ${to}`);
  }
}

/**
 * Whether the legacy stack may fall back to stackless R2 keys. True only for
 * the one configured legacy stack while the migration is not yet contracted;
 * every other stack must never probe a stackless key (cross-stack exposure).
 */
export function shouldUseStacklessFallback(
  stackId: string,
  state: CutoverState,
  legacyStackId: string | null,
): boolean {
  if (legacyStackId === null || stackId !== legacyStackId) return false;
  return state === "migrating" || state === "cutover";
}

export interface CutoverContext {
  readonly db: D1Database;
}

export class CutoverController {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async state(): Promise<CutoverState> {
    return readCutoverState(this.#db);
  }

  async legacyStackId(): Promise<string | null> {
    return readLegacyStackId(this.#db);
  }

  async transition(to: CutoverState): Promise<CutoverState> {
    const from = await this.state();
    requireCutoverTransition(from, to);
    await writeCutoverState(this.#db, to);
    return to;
  }

  /** The gate blocking second-stack tenant traffic until contract. */
  async allowStackTenantTraffic(stackId: string): Promise<boolean> {
    const legacyStackId = await this.legacyStackId();
    if (legacyStackId === null) return false; // no legacy data yet: provision only
    if (stackId === legacyStackId) return true; // legacy stack serves its data
    const state = await this.state();
    return state === "contracted";
  }
}
