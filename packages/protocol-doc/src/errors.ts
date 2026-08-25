export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number, readonly attempted: number) {
    super(`Version conflict: current version is ${currentVersion}, attempted ${attempted}`);
    this.name = "VersionConflictError";
  }
}

export class DeltaRejectedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "DeltaRejectedError";
  }
}

export class DocNotFoundError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "DocNotFoundError";
  }
}

export class DocExistsError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "DocExistsError";
  }
}

export class StorageCorruptError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StorageCorruptError";
  }
}

export class RootRefsError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "RootRefsError";
  }
}