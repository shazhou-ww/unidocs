// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createFileManifest, encodeFileManifest, FileManifestContentType, type TenantFileRootInfo } from "@unicas/tenant-file-client";
import { PlaygroundView } from "../src/ui/views/file-playground.js";
import "fake-indexeddb/auto";
import { createPlaygroundCacheSession, PlaygroundCacheContext } from "../src/ui/playground-cache.js";

const stackId = "cas_cache";
const manifestHash = "a".repeat(64);
const fileHash = "b".repeat(64);
const manifest = encodeFileManifest(createFileManifest([
  { path: "Documents", type: "directory" },
  { path: "Documents/Notes.txt", type: "file", ref: 0, size: 42, mediaType: "text/plain" },
  { path: "Photo.png", type: "file", ref: 1, size: 2048, mediaType: "image/png" },
]));
let roots: TenantFileRootInfo[];
let failCommit: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  failCommit = false;
  roots = ["Alpha", "Beta"].map((name) => ({ rootId: name, name, manifestHash, revision: 1, createdAt: 1, updatedAt: 1 }));
  document.head.innerHTML = '<meta name="x-csrf-token" content="csrf-1" />';
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://cas.example").pathname;
    if (path.endsWith("/managed-issuer")) return json({ status: "active" });
    if (path.endsWith("/managed-capabilities")) return json({ accessToken: "memory-token", audience: `https://cas.example/stacks/${stackId}`, tenantId: "member_test", expiresAt: Date.now() + 60_000 });
    if (path.endsWith("/file-roots")) return json({ items: roots });
    if (path.includes("/file-roots/") && init?.method === "PATCH") {
      if (failCommit) return json({ error: "REVISION_MISMATCH", message: "Revision conflict" }, 409);
      const rootId = path.split("/").at(-1);
      const root = roots.find((item) => item.rootId === rootId)!;
      Object.assign(root, JSON.parse(String(init.body)), { revision: root.revision + 1 });
      return json(root);
    }
    if (init?.method === "POST" || init?.method === "PUT") return json({ hash: manifestHash, ready: true, revision: 1, leaseStartedAt: 1, leaseExpiresAt: 2, success: true });
    if (path.endsWith("/metadata")) return json({ metadata: { hash: manifestHash, size: manifest.length, contentType: FileManifestContentType, refs: [fileHash, fileHash] } });
    if (path.endsWith("/content")) return new Response(Uint8Array.from(manifest));
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectRoot(user: ReturnType<typeof userEvent.setup>, name: string) {
  const sidebar = await screen.findByRole("complementary", { name: "File roots" });
  await user.click(within(sidebar).getByRole("button", { name: new RegExp(name) }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh files" })).toBeEnabled());
}

test("switches cached roots and folders without requests and preserves each root path", async () => {
  const user = userEvent.setup();
  render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  expect(screen.getByRole("table", { name: "Folder contents" }).closest(".card")).toBeNull();
  expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  const initialRequests = fetchMock.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Documents", exact: true }));
  expect(await screen.findByRole("button", { name: "Notes.txt" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Photo.png" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(initialRequests);
  await selectRoot(user, "Beta");
  const loadedRequests = fetchMock.mock.calls.length;
  await selectRoot(user, "Alpha");
  expect(screen.getByRole("button", { name: "Notes.txt" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Parent folder" }));
  expect(await screen.findByRole("button", { name: "Photo.png" })).toBeInTheDocument();
  await selectRoot(user, "Beta");
  expect(fetchMock).toHaveBeenCalledTimes(loadedRequests);
  await user.click(screen.getByRole("button", { name: "Usage" }));
  await selectRoot(user, "Alpha");
  expect(fetchMock).toHaveBeenCalledTimes(loadedRequests);
});

test("refreshes from the server and invalidates roots with changed revisions", async () => {
  const user = userEvent.setup();
  render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  await selectRoot(user, "Beta");
  roots[0] = { ...roots[0], revision: 2 };
  const previous = fetchMock.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Refresh files" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh files" })).toBeEnabled());
  expect(fetchMock.mock.calls.length).toBeGreaterThan(previous);
  const refreshed = fetchMock.mock.calls.length;
  await selectRoot(user, "Alpha");
  expect(fetchMock.mock.calls.length).toBeGreaterThan(refreshed);
});

test("creates folders, copies within a folder, renames and deletes selected entries", async () => {
  const user = userEvent.setup();
  const prompt = vi.spyOn(window, "prompt").mockReturnValue("Archive");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  await user.click(screen.getByRole("button", { name: "New folder" }));
  await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Archive{Enter}");
  expect(await screen.findByRole("button", { name: "Archive", exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Select Photo.png" }));
  prompt.mockReturnValue("/");
  await user.click(screen.getByRole("button", { name: "Copy selected items" }));
  expect(await screen.findByRole("button", { name: "Photo copy.png" })).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Select Photo copy.png" }));
  prompt.mockReturnValue("Other.png");
  await user.click(screen.getByRole("button", { name: "Rename selected item" }));
  expect(await screen.findByRole("button", { name: "Other.png" })).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Select Other.png" }));
  await user.click(screen.getByRole("button", { name: "Delete selected items" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Other.png" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Photo.png" })).toBeInTheDocument();
});

test("discards failed mutations before a cached root can be reused", async () => {
  const user = userEvent.setup();
  render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  failCommit = true;
  await user.click(screen.getByRole("button", { name: "New folder" }));
  await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Uncommitted{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict");
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Uncommitted");
  await selectRoot(user, "Beta");
  const requests = fetchMock.mock.calls.length;
  await selectRoot(user, "Alpha");
  expect(fetchMock.mock.calls.length).toBeGreaterThan(requests);
  expect(screen.queryByRole("button", { name: "Uncommitted" })).not.toBeInTheDocument();
});

test("opens and cancels folder creation without native prompts or writes", async () => {
  const user = userEvent.setup();
  const prompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("prompt() is not supported"); });
  render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  const requestCount = fetchMock.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "New folder" }));
  expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Create folder" })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "Folder name" }), "../invalid{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("without path separators");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  expect(prompt).not.toHaveBeenCalled();
});

test("does not reuse roots or tenant credentials across stacks", async () => {
  const user = userEvent.setup();
  const view = render(<PlaygroundView stackId={stackId} />);
  await selectRoot(user, "Alpha");
  view.rerender(<PlaygroundView stackId="cas_other" />);
  await selectRoot(user, "Alpha");
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/managed-capabilities"))).toHaveLength(2);
  expect(fetchMock.mock.calls.some(([path]) => String(path) === "/admin/stacks/cas_other/managed-capabilities")).toBe(true);
});

test("reopens persisted manifests after a fresh session and catalog check, then clears on logout", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const user = userEvent.setup();
  const identity = { identityIssuer: "https://login.example", subject: "cache-integration" };
  let session = createPlaygroundCacheSession(identity);
  const mount = () => render(<PlaygroundCacheContext value={session}><PlaygroundView stackId={stackId} /></PlaygroundCacheContext>);
  let view = mount();
  try {
    await selectRoot(user, "Alpha");
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/content"))).toHaveLength(1);
    view.unmount();
    session.close();
    session = createPlaygroundCacheSession(identity);
    fetchMock.mockClear();
    view = mount();
    await selectRoot(user, "Alpha");
    expect(screen.getByRole("button", { name: "Photo.png" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/file-roots"))).toBe(true);
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/managed-capabilities"))).toBe(true);
    expect(fetchMock.mock.calls.filter(([path]) => /\/(metadata|content)$/.test(String(path)))).toHaveLength(0);
    view.unmount();
    session.close();
    session = createPlaygroundCacheSession(identity);
    await session.clear();
    session = createPlaygroundCacheSession(identity);
    fetchMock.mockClear();
    view = mount();
    await selectRoot(user, "Alpha");
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/content"))).toHaveLength(1);
  } finally {
    view.unmount();
    await session.clear();
  }
});

test("does not display persisted content when the fresh catalog denies access", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const user = userEvent.setup();
  const session = createPlaygroundCacheSession({ identityIssuer: "https://login.example", subject: "cache-denied" });
  const mount = () => render(<PlaygroundCacheContext value={session}><PlaygroundView stackId={stackId} /></PlaygroundCacheContext>);
  let view = mount();
  try {
    await selectRoot(user, "Alpha");
    view.unmount();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/file-roots")
      ? Promise.resolve(json({ error: "FORBIDDEN", message: "Access revoked" }, 403))
      : original(input, init));
    fetchMock.mockClear();
    view = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Access revoked");
    expect(screen.queryByRole("table", { name: "Folder contents" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path]) => /\/(metadata|content)$/.test(String(path)))).toHaveLength(0);
  } finally { view.unmount(); await session.clear(); }
});