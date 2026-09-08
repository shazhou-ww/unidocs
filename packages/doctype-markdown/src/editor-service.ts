import type {
  ChangeSet,
  EditorContext,
  Invocation,
  ServiceResult,
  StateSource,
} from "@unidocs/protocol-doctype";
import { isEditorContext, isStateSource, serviceFailure, serviceSuccess } from "@unidocs/protocol-doctype";
import type { SBlob } from "@unidocs/protocol";
import { createMarkdownDocumentType } from "./markdown.js";
import type { MDoc } from "./types.js";

export const MarkdownSchemaVersion = "markdown/1";

export interface MarkdownV1Operation {
  readonly kind: "setContent";
  readonly payload: { readonly content: string };
}

export interface MarkdownEditorServiceOptions {
  readonly loadSnapshot: (blob: SBlob) => Promise<unknown>;
  readonly createContextId?: () => string;
  readonly now?: () => number;
  readonly contextTtlMs?: number;
  readonly maxContexts?: number;
}

interface StoredContext {
  readonly binding: Omit<Invocation, "requestId">;
  readonly sequence: number;
  readonly document: MDoc;
  readonly expiresAt: number;
}

const markdown = createMarkdownDocumentType({
  makeSBlob: async () => { throw new Error("Markdown v1 cannot write resources"); },
  openSBlob: async () => { throw new Error("Markdown v1 cannot open resources"); },
});

export class MarkdownEditorService {
  readonly #contexts = new Map<string, StoredContext>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #loadSnapshot: MarkdownEditorServiceOptions["loadSnapshot"];
  readonly #createContextId: () => string;
  readonly #now: () => number;
  readonly #contextTtlMs: number;
  readonly #maxContexts: number;
  #initializing = 0;

  constructor(options: MarkdownEditorServiceOptions) {
    this.#loadSnapshot = options.loadSnapshot;
    this.#createContextId = options.createContextId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#contextTtlMs = options.contextTtlMs ?? 300_000;
    this.#maxContexts = options.maxContexts ?? 128;
    for (const limit of [this.#contextTtlMs, this.#maxContexts]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid context limit");
    }
  }

  async init(
    invocation: Invocation,
    source: StateSource<MarkdownV1Operation>,
    loadSnapshot: MarkdownEditorServiceOptions["loadSnapshot"] = this.#loadSnapshot,
  ): Promise<ServiceResult<EditorContext>> {
    if (!isInvocation(invocation) || !isStateSource<MarkdownV1Operation>(source, isOperation)) {
      return serviceFailure("invalid_request", "Invalid Markdown initialization");
    }
    if (invocation.docType !== "markdown") {
      return serviceFailure("invalid_request", "Expected Markdown document type");
    }
    if (source.schemaVersion !== MarkdownSchemaVersion) {
      return serviceFailure("unsupported_schema", "Unsupported Markdown schema");
    }

    this.#pruneExpired();
    if (this.#contexts.size + this.#initializing >= this.#maxContexts) {
      return serviceFailure("limit_exceeded", "Editor context capacity reached");
    }
    const binding = invocationBinding(invocation);
    const changes = source.changes.map(copyChangeSet);
    const base = source.base === null ? null : { ...source.base };
    this.#initializing++;
    try {
      let document: MDoc;
      if (base === null) {
        document = await markdown.init();
      } else {
        let snapshot: unknown;
        try {
          snapshot = await loadSnapshot(base);
        } catch {
          return serviceFailure("resource_unavailable", "Markdown snapshot is unavailable");
        }
        document = requireDocument(snapshot);
      }

      for (const changeSet of changes) {
        document = await applyChangeSet(document, changeSet);
      }

      const contextId = this.#createContextId();
      if (typeof contextId !== "string" || contextId.length === 0 || this.#contexts.has(contextId)) {
        return serviceFailure("internal_error", "Cannot allocate a fresh editor context");
      }
      this.#contexts.set(contextId, {
        binding,
        sequence: 0,
        document,
        expiresAt: this.#now() + this.#contextTtlMs,
      });
      return serviceSuccess({ contextId, sequence: 0 });
    } catch {
      return serviceFailure("operation_rejected", "Invalid Markdown state or operation");
    } finally {
      this.#initializing--;
    }
  }

  async apply(
    invocation: Invocation,
    context: EditorContext,
    changeSet: ChangeSet<MarkdownV1Operation>,
  ): Promise<ServiceResult<EditorContext>> {
    if (!isInvocation(invocation) || !isEditorContext(context)) {
      return serviceFailure("invalid_request", "Invalid Markdown apply request");
    }
    if (!isChangeSet(changeSet)) {
      return serviceFailure("operation_rejected", "Invalid Markdown changeset");
    }
    const fixedInvocation = { ...invocation };
    const fixedContext = { ...context };
    const fixedChangeSet = copyChangeSet(changeSet);
    return this.#serialize(context.contextId, () => this.#apply(fixedInvocation, fixedContext, fixedChangeSet));
  }

  async #apply(
    invocation: Invocation,
    context: EditorContext,
    changeSet: ChangeSet<MarkdownV1Operation>,
  ): Promise<ServiceResult<EditorContext>> {
    const stored = this.#getContext(context.contextId);
    if (stored === undefined || !sameBinding(stored.binding, invocation)) {
      return serviceFailure("context_lost", "Editor context is unavailable");
    }
    if (stored.sequence !== context.sequence) {
      return serviceFailure("sequence_conflict", "Editor context sequence does not match");
    }
    if (stored.sequence === Number.MAX_SAFE_INTEGER) {
      return serviceFailure("limit_exceeded", "Editor context sequence exhausted");
    }

    try {
      const document = await applyChangeSet(stored.document, changeSet);
      if (this.#getContext(context.contextId) !== stored) {
        return serviceFailure("context_lost", "Editor context is unavailable");
      }
      const next = { ...stored, sequence: stored.sequence + 1, document };
      this.#contexts.set(context.contextId, next);
      return serviceSuccess({ contextId: context.contextId, sequence: next.sequence });
    } catch {
      return serviceFailure("operation_rejected", "Invalid Markdown operation");
    }
  }

  async snapshot(
    invocation: Invocation,
    context: EditorContext,
  ): Promise<ServiceResult<MDoc>> {
    if (!isInvocation(invocation) || !isEditorContext(context)) {
      return serviceFailure("invalid_request", "Invalid Markdown snapshot request");
    }
    const fixedInvocation = { ...invocation };
    const fixedContext = { ...context };
    return this.#serialize(context.contextId, () => this.#snapshot(fixedInvocation, fixedContext));
  }

  #snapshot(invocation: Invocation, context: EditorContext): ServiceResult<MDoc> {
    const stored = this.#getContext(context.contextId);
    if (stored === undefined || !sameBinding(stored.binding, invocation)) {
      return serviceFailure("context_lost", "Editor context is unavailable");
    }
    if (stored.sequence !== context.sequence) {
      return serviceFailure("sequence_conflict", "Editor context sequence does not match");
    }
    return serviceSuccess({ content: stored.document.content });
  }

  #getContext(contextId: string): StoredContext | undefined {
    const stored = this.#contexts.get(contextId);
    if (stored && stored.expiresAt <= this.#now()) {
      this.#contexts.delete(contextId);
      return undefined;
    }
    return stored;
  }

  #pruneExpired(): void {
    for (const contextId of this.#contexts.keys()) this.#getContext(contextId);
  }

  async #serialize<T>(contextId: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.#queues.get(contextId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => {}, () => {});
    this.#queues.set(contextId, tail);
    try {
      return await result;
    } finally {
      if (this.#queues.get(contextId) === tail) this.#queues.delete(contextId);
    }
  }
}

async function applyChangeSet(document: MDoc, changeSet: ChangeSet<MarkdownV1Operation>): Promise<MDoc> {
  for (const operation of changeSet.operations) requireOperation(operation);
  return markdown.apply(changeSet.operations, document);
}

function requireDocument(value: unknown): MDoc {
  if (!isRecord(value) || !hasKeys(value, ["content"]) || typeof value.content !== "string") {
    throw new TypeError("Invalid Markdown snapshot");
  }
  return { content: value.content };
}

function requireOperation(value: unknown): asserts value is MarkdownV1Operation {
  if (!isOperation(value)) throw new TypeError("Invalid Markdown operation");
}

export function isOperation(value: unknown): value is MarkdownV1Operation {
  return isRecord(value) && hasKeys(value, ["kind", "payload"])
    && value.kind === "setContent" && isRecord(value.payload)
    && hasKeys(value.payload, ["content"]) && typeof value.payload.content === "string";
}

export function isChangeSet(value: unknown): value is ChangeSet<MarkdownV1Operation> {
  return isRecord(value) && hasKeys(value, ["operations"])
    && Array.isArray(value.operations) && Array.from(value.operations).every(isOperation);
}

function copyChangeSet(changeSet: ChangeSet<MarkdownV1Operation>): ChangeSet<MarkdownV1Operation> {
  return { operations: changeSet.operations.map((operation) => ({
    kind: "setContent", payload: { content: operation.payload.content },
  })) };
}

export function isInvocation(value: unknown): value is Invocation {
  const keys = ["requestId", "actorId", "tenantId", "docId", "docType"];
  return isRecord(value) && hasKeys(value, keys)
    && keys.every((key) => typeof value[key] === "string" && value[key].length > 0);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invocationBinding(invocation: Invocation): Omit<Invocation, "requestId"> {
  const { actorId, tenantId, docId, docType } = invocation;
  return { actorId, tenantId, docId, docType };
}

function sameBinding(binding: Omit<Invocation, "requestId">, invocation: Invocation): boolean {
  return binding.actorId === invocation.actorId
    && binding.tenantId === invocation.tenantId
    && binding.docId === invocation.docId
    && binding.docType === invocation.docType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}