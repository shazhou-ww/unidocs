import { createCasBlobClient, storeNodeContent } from "@unicas/tenant-blob-client";
import { createFileManifest, decodeFileManifest, encodeFileManifest, fileManifestRefs } from "./file-manifest.js";
import { FileManifestContentType, type TenantFileManifestEntry } from "./file-protocol.js";
import type {
  TenantFileRoot,
  TenantFileRootInfo,
  TenantFileStat,
  TenantFileSystem,
  TenantFileSystemOptions,
} from "./types.js";

interface WorkingDirectory {
  readonly type: "directory";
}

interface WorkingFile {
  readonly type: "file";
  readonly hash: string;
  readonly size: number;
  readonly mediaType: string;
}

type WorkingEntry = WorkingDirectory | WorkingFile;

export function createTenantFileSystem(options: TenantFileSystemOptions): TenantFileSystem {
  const blobs = createCasBlobClient(options.cas);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());

  async function storeManifest(entries: ReadonlyMap<string, WorkingEntry>): Promise<string> {
    const sorted = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
    const refs: string[] = [];
    const manifestEntries: TenantFileManifestEntry[] = sorted.map(([path, entry]) => {
      if (entry.type === "directory") return { type: "directory", path };
      refs.push(entry.hash);
      return { type: "file", path, ref: refs.length - 1, size: entry.size, mediaType: entry.mediaType };
    });
    return storeNodeContent(
      options.cas,
      encodeFileManifest(createFileManifest(manifestEntries)),
      FileManifestContentType,
      refs,
    );
  }

  async function retain(hash: string): Promise<void> {
    await blobs.retain({ requestId: createRequestId(), references: { [hash]: 1 } });
  }

  async function release(hash: string): Promise<void> {
    await blobs.release({ requestId: createRequestId(), references: { [hash]: 1 } });
  }

  async function loadRoot(info: TenantFileRootInfo): Promise<TenantFileRoot> {
    const metadata = await options.cas.readMetadata(info.manifestHash);
    if (metadata.contentType !== FileManifestContentType) throw new TypeError("File root has an unsupported manifest type");
    const bytes = new Uint8Array(await new Response(await options.cas.readContent(info.manifestHash)).arrayBuffer());
    const manifest = decodeFileManifest(bytes);
    const refs = fileManifestRefs(manifest, metadata.refs);
    return workingRoot(info, new Map(manifest.entries.map((entry) => [
      entry.path,
      entry.type === "directory"
        ? { type: "directory" as const }
        : { type: "file" as const, hash: refs.get(entry.path)!, size: entry.size, mediaType: entry.mediaType },
    ])));
  }

  function workingRoot(initialInfo: TenantFileRootInfo, initialEntries: ReadonlyMap<string, WorkingEntry>): TenantFileRoot {
    let info = initialInfo;
    let committedName = info.name;
    let name = info.name;
    let committedEntries = cloneEntries(initialEntries);
    let entries = cloneEntries(initialEntries);

    const root: TenantFileRoot = {
      get info() { return info; },
      get dirty() { return name !== committedName || !sameEntries(entries, committedEntries); },
      async stat(path) {
        const normalized = normalizePath(path);
        if (normalized === "") return { path: "/", name: "/", type: "directory" };
        const entry = entries.get(normalized) ?? (hasDescendant(entries, normalized) ? { type: "directory" as const } : undefined);
        if (!entry) throw new TypeError(`Path not found: ${path}`);
        return toStat(normalized, entry);
      },
      async readdir(path) {
        const directory = normalizePath(path);
        if ((await root.stat(path)).type !== "directory") throw new TypeError(`Not a directory: ${path}`);
        const children = new Map<string, WorkingEntry>();
        const prefix = directory === "" ? "" : `${directory}/`;
        for (const [entryPath, entry] of entries) {
          if (!entryPath.startsWith(prefix)) continue;
          const remainder = entryPath.slice(prefix.length);
          if (remainder.length === 0) continue;
          const separator = remainder.indexOf("/");
          const segment = separator < 0 ? remainder : remainder.slice(0, separator);
          children.set(prefix + segment, separator < 0 ? entry : { type: "directory" });
        }
        return [...children.entries()].map(([childPath, entry]) => toStat(childPath, entry)).sort(compareStats);
      },
      async read(path, range, signal) {
        const entry = entries.get(normalizePath(path));
        if (!entry) throw new TypeError(`Path not found: ${path}`);
        if (entry.type !== "file") throw new TypeError(`Not a file: ${path}`);
        return (await blobs.openBlob(entry.hash, signal)).read(range, signal);
      },
      async write(path, source, writeOptions) {
        const normalized = normalizeMutablePath(path);
        requireParent(entries, normalized);
        if (entries.get(normalized)?.type === "directory" || hasDescendant(entries, normalized)) {
          throw new TypeError(`Path is a directory: ${path}`);
        }
        const stored = await blobs.storeBlob(source, writeOptions);
        entries.set(normalized, { type: "file", hash: stored.hash, size: stored.size, mediaType: stored.contentType });
      },
      async mkdir(path) {
        const normalized = normalizeMutablePath(path);
        requireParent(entries, normalized);
        if (entries.has(normalized) || hasDescendant(entries, normalized)) throw new TypeError(`Path already exists: ${path}`);
        entries.set(normalized, { type: "directory" });
      },
      async move(from, to) { moveOrCopy(entries, from, to, true); },
      async copy(from, to) { moveOrCopy(entries, from, to, false); },
      async remove(path) {
        const normalized = normalizeMutablePath(path);
        if (!entries.has(normalized) && !hasDescendant(entries, normalized)) throw new TypeError(`Path not found: ${path}`);
        entries.delete(normalized);
        for (const entryPath of [...entries.keys()]) {
          if (entryPath.startsWith(`${normalized}/`)) entries.delete(entryPath);
        }
      },
      async rename(nextName) { name = validateRootName(nextName); },
      async commit() {
        if (!root.dirty) return info;
        const manifestHash = sameEntries(entries, committedEntries) ? info.manifestHash : await storeManifest(entries);
        if (manifestHash !== info.manifestHash) await retain(manifestHash);
        let updated: TenantFileRootInfo;
        try {
          updated = await options.catalog.update({ rootId: info.rootId, revision: info.revision, name, manifestHash });
        } catch (error) {
          if (manifestHash !== info.manifestHash) await release(manifestHash).catch(() => undefined);
          throw error;
        }
        const previousHash = info.manifestHash;
        info = updated;
        committedName = name;
        committedEntries = cloneEntries(entries);
        if (manifestHash !== previousHash) await release(previousHash).catch(() => undefined);
        return info;
      },
      discard() {
        name = committedName;
        entries = cloneEntries(committedEntries);
      },
    };
    return Object.freeze(root);
  }

  const fileSystem: TenantFileSystem = {
    listRoots: () => options.catalog.list(),
    async createRoot(rawName) {
      const name = validateRootName(rawName);
      const manifestHash = await storeManifest(new Map());
      await retain(manifestHash);
      try {
        return loadRoot(await options.catalog.create({ rootId: createId(), name, manifestHash }));
      } catch (error) {
        await release(manifestHash).catch(() => undefined);
        throw error;
      }
    },
    async openRoot(rootId) {
      const info = (await options.catalog.list()).find((candidate) => candidate.rootId === rootId);
      if (!info) throw new TypeError(`File root not found: ${rootId}`);
      return loadRoot(info);
    },
    async deleteRoot(rootId) {
      const info = (await options.catalog.list()).find((candidate) => candidate.rootId === rootId);
      if (!info) throw new TypeError(`File root not found: ${rootId}`);
      await options.catalog.delete({ rootId, revision: info.revision });
      await release(info.manifestHash);
    },
  };
  return Object.freeze(fileSystem);
}

function normalizePath(path: string): string {
  if (path === "/") return "";
  if (typeof path !== "string" || !path.startsWith("/") || path.endsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(path)) throw new TypeError(`Invalid absolute path: ${path}`);
  const normalized = path.slice(1);
  if (normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`Invalid absolute path: ${path}`);
  }
  return normalized;
}

function normalizeMutablePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "") throw new TypeError("The root directory cannot be modified");
  return normalized;
}

function validateRootName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError("Root name must be 1-120 characters without controls");
  }
  return name;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function requireParent(entries: ReadonlyMap<string, WorkingEntry>, path: string): void {
  const parent = parentPath(path);
  if (parent === "") return;
  const entry = entries.get(parent);
  if (entry?.type === "file" || (!entry && !hasDescendant(entries, parent))) {
    throw new TypeError(`Parent directory not found: /${parent}`);
  }
}

function hasDescendant(entries: ReadonlyMap<string, WorkingEntry>, path: string): boolean {
  for (const entryPath of entries.keys()) if (entryPath.startsWith(`${path}/`)) return true;
  return false;
}

function moveOrCopy(entries: Map<string, WorkingEntry>, from: string, to: string, removeSource: boolean): void {
  const source = normalizeMutablePath(from);
  const target = normalizeMutablePath(to);
  const sourceEntry = entries.get(source);
  const descendants = [...entries.entries()].filter(([path]) => path.startsWith(`${source}/`));
  if (!sourceEntry && descendants.length === 0) throw new TypeError(`Path not found: ${from}`);
  if (target === source || target.startsWith(`${source}/`)) throw new TypeError("Cannot place a path inside itself");
  requireParent(entries, target);
  if (entries.has(target) || hasDescendant(entries, target)) throw new TypeError(`Path already exists: ${to}`);
  if (sourceEntry) entries.set(target, { ...sourceEntry });
  for (const [path, entry] of descendants) entries.set(`${target}${path.slice(source.length)}`, { ...entry });
  if (removeSource) {
    entries.delete(source);
    for (const [path] of descendants) entries.delete(path);
  }
}

function toStat(path: string, entry: WorkingEntry): TenantFileStat {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return entry.type === "directory"
    ? { path: `/${path}`, name, type: "directory" }
    : { path: `/${path}`, name, type: "file", size: entry.size, mediaType: entry.mediaType };
}

function compareStats(left: TenantFileStat, right: TenantFileStat): number {
  return left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1;
}

function cloneEntries(entries: ReadonlyMap<string, WorkingEntry>): Map<string, WorkingEntry> {
  return new Map([...entries].map(([path, entry]) => [path, { ...entry }]));
}

function sameEntries(left: ReadonlyMap<string, WorkingEntry>, right: ReadonlyMap<string, WorkingEntry>): boolean {
  if (left.size !== right.size) return false;
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (!other || JSON.stringify(entry) !== JSON.stringify(other)) return false;
  }
  return true;
}