import { sBlobSignature } from "@unidocs/protocol";
import type { SBlob, SValueType } from "@unidocs/protocol";
import { ServiceErrorCodes } from "./contracts.js";
import type { ChangeSet, EditorContext, OperatorSession, ServiceErrorCode, ServiceResult, StateSource } from "./contracts.js";

export type ValueGuard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function isSBlobReference(value: unknown): value is SBlob {
  return isRecord(value)
    && Object.hasOwn(value, sBlobSignature)
    && Reflect.get(value, sBlobSignature) === true
    && typeof value.hash === "string"
    && value.hash.length > 0;
}

export function createChangeSet<TOp>(operations: readonly SValueType<TOp>[]): ChangeSet<TOp> {
  return { operations: [...operations] };
}

export function createStateSource<TOp>(
  schemaVersion: string,
  base: SBlob | null,
  changes: readonly ChangeSet<TOp>[],
): StateSource<TOp> {
  return {
    schemaVersion,
    base,
    changes: changes.map((change) => createChangeSet<TOp>(change.operations)),
  };
}

export function isStateSource<TOp>(value: unknown, isOperation: ValueGuard<SValueType<TOp>>): value is StateSource<TOp> {
  return isRecord(value)
    && hasKeys(value, ["schemaVersion", "base", "changes"])
    && typeof value.schemaVersion === "string" && value.schemaVersion.length > 0
    && (value.base === null || isSBlobReference(value.base))
    && Array.isArray(value.changes)
    && Array.from(value.changes).every((change: unknown) => isRecord(change)
      && hasKeys(change, ["operations"])
      && Array.isArray(change.operations)
      && Array.from(change.operations).every(isOperation));
}

export function isEditorContext(value: unknown): value is EditorContext {
  return isRecord(value)
    && hasKeys(value, ["contextId", "sequence"])
    && typeof value.contextId === "string" && value.contextId.length > 0
    && typeof value.sequence === "number" && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0;
}

export function isOperatorSession(value: unknown): value is OperatorSession {
  return isRecord(value)
    && hasKeys(value, ["operatorSessionId", "generation"])
    && typeof value.operatorSessionId === "string" && value.operatorSessionId.length > 0
    && typeof value.generation === "number" && Number.isSafeInteger(value.generation)
    && value.generation >= 0;
}

export function serviceSuccess<T>(data: SValueType<T>): ServiceResult<T> {
  return { success: true, data };
}

export function serviceFailure(code: ServiceErrorCode, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

export function isServiceResult<T>(value: unknown, isData: ValueGuard<SValueType<T>>): value is ServiceResult<T> {
  if (!isRecord(value)) return false;
  if (value.success === true) return hasKeys(value, ["success", "data"]) && isData(value.data);
  const error = value.error;
  return value.success === false
    && hasKeys(value, ["success", "error"])
    && isRecord(error) && hasKeys(error, ["code", "message"])
    && typeof error.code === "string"
    && ServiceErrorCodes.some((code) => code === error.code)
    && typeof error.message === "string";
}