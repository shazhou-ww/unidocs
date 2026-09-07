import { applyOne } from "@unidocs/doctype-psd/engine";
import type { PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import type { RenderLike } from "./doc-session.js";

export interface DraftCandidate {
  readonly candidateId: string;
  readonly baseVersion: number;
  readonly sequence: number;
  readonly operations: readonly PsdOp[];
}

export type DraftCommitResult =
  | { status: "committed"; version: number }
  | { status: "rejected" }
  | { status: "unknown" };

export interface DraftCheckpoint {
  schema: 1;
  doc: PsdDoc;
  baseVersion: number;
  sequence: number;
  operations: PsdOp[];
  candidate: DraftCandidate | null;
}

export class EditorDraft {
  readonly #render: RenderLike;
  readonly #generateId: () => string;
  #doc: PsdDoc;
  #baseVersion: number;
  #operations: PsdOp[] = [];
  #sequence = 0;
  #candidate: DraftCandidate | null = null;
  #completed = new Map<string, DraftCommitResult>();
  #frozen = false;
  #renderFailed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { doc: PsdDoc; baseVersion: number; render: RenderLike; generateId?: () => string }) {
    if (!Number.isSafeInteger(options.baseVersion) || options.baseVersion < 1) throw new Error("Invalid base version");
    this.#doc = options.doc;
    this.#baseVersion = options.baseVersion;
    this.#render = options.render;
    this.#generateId = options.generateId ?? (() => crypto.randomUUID());
  }

  get doc(): PsdDoc { return this.#doc; }
  get baseVersion(): number { return this.#baseVersion; }
  get sequence(): number { return this.#sequence; }
  get dirty(): boolean { return this.#operations.length > 0; }
  get frozen(): boolean { return this.#frozen; }

  checkpoint(): Promise<DraftCheckpoint> {
    return this.#enqueue(async () => structuredClone({
      schema: 1 as const, doc: this.#doc,
      baseVersion: this.#baseVersion, sequence: this.#sequence,
      operations: this.#operations, candidate: this.#candidate
    }));
  }

  static restore(checkpoint: DraftCheckpoint, render: RenderLike): EditorDraft {
    if (checkpoint.schema !== 1 || !Number.isSafeInteger(checkpoint.sequence)
      || checkpoint.sequence < checkpoint.operations.length) throw new Error("Invalid draft checkpoint");
    const saved = structuredClone(checkpoint);
    const draft = new EditorDraft({ doc: saved.doc, baseVersion: saved.baseVersion, render });
    draft.#sequence = saved.sequence;
    draft.#operations = saved.operations;
    if (saved.candidate) {
      if (saved.candidate.baseVersion !== saved.baseVersion || saved.candidate.sequence !== saved.sequence
        || saved.candidate.operations.length !== saved.operations.length || !saved.operations.length) throw new Error("Invalid pending candidate");
      draft.#candidate = Object.freeze({ ...saved.candidate, operations: Object.freeze(saved.candidate.operations) });
      draft.#frozen = true;
    }
    return draft;
  }

  #enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => { });
    return result;
  }

  applyLocal(operation: PsdOp): Promise<[number, number, number, number]> {
    if (this.#frozen) return Promise.reject(new Error("Draft is frozen"));
    return this.#enqueue(async () => {
      if (this.#renderFailed) throw new Error("Renderer recovery required");
      const next = applyOne(this.#doc, operation);
      let rect: [number, number, number, number];
      try {
        rect = await this.#render.applyOp(operation);
      } catch (error) {
        try { await this.#render.reset(this.#doc); }
        catch { this.#renderFailed = true; }
        throw error;
      }
      this.#doc = next;
      this.#operations.push(operation);
      this.#sequence += 1;
      return rect;
    });
  }

  prepareCommit(): Promise<DraftCandidate> {
    this.#frozen = true;
    return this.#enqueue(async () => {
      if (this.#candidate) return this.#candidate;
      if (this.#renderFailed || !this.dirty) {
        this.#frozen = false;
        throw new Error(this.#renderFailed ? "Renderer recovery required" : "No changes");
      }
      this.#candidate = Object.freeze({
        candidateId: this.#generateId(),
        baseVersion: this.#baseVersion,
        sequence: this.#sequence,
        operations: Object.freeze([...this.#operations]),
      });
      return this.#candidate;
    });
  }

  acceptResult(candidateId: string, result: DraftCommitResult): Promise<void> {
    return this.#enqueue(async () => {
      const completed = this.#completed.get(candidateId);
      if (completed) {
        if (completed.status === result.status
          && (completed.status !== "committed" || (result.status === "committed" && completed.version === result.version))) return;
        throw new Error("Conflicting result for completed candidate");
      }
      const candidate = this.#candidate;
      if (!candidate || candidate.candidateId !== candidateId) throw new Error("Unknown candidate");
      if (result.status === "unknown") return;
      if (result.status === "committed") {
        if (result.version !== candidate.baseVersion + 1 || !Number.isSafeInteger(result.version)) throw new Error("Invalid committed version");
        this.#baseVersion = result.version;
        this.#operations = [];
      }
      this.#completed.set(candidateId, { ...result });
      this.#candidate = null;
      this.#frozen = false;
    });
  }

  recoverRenderer(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#render.reset(this.#doc);
      this.#renderFailed = false;
    });
  }
}