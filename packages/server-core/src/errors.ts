export class VersionConflictError extends Error {   // → HTTP 409,body 带当前 version
  constructor(readonly currentVersion: number, readonly attempted: number) {
    super(`Version conflict: current version is ${currentVersion}, attempted ${attempted}`);
    this.name = "VersionConflictError";
  }
}

export class DeltaRejectedError extends Error {    // → HTTP 400,config.apply 抛出
  constructor(message?: string) {
    super(message);
    this.name = "DeltaRejectedError";
  }
}

export class DocNotFoundError extends Error {       // → HTTP 404
  constructor(message?: string) {
    super(message);
    this.name = "DocNotFoundError";
  }
}

export class DocExistsError extends Error {         // → HTTP 409
  constructor(message?: string) {
    super(message);
    this.name = "DocExistsError";
  }
}

export class StorageCorruptError extends Error {    // → HTTP 500
  // The source of truth references a snapshot the blob store does not have.
  // Not "document missing" — the log says it must exist, so storage lost it.
  constructor(message?: string) {
    super(message);
    this.name = "StorageCorruptError";
  }
}

export class RootRefsError extends Error {          // → HTTP 502
  constructor(message?: string) {
    super(message);
    this.name = "RootRefsError";
  }
}
