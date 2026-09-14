import { expect, test } from "vitest";
import { encodeSValue } from "@unidocs/svalue-codec";
import { createPlatformClient, PlatformRequestError } from "../src/platform-client.js";

const AT = "2026-09-14T12:00:00.000Z";

function binding(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const PLATFORM_SERVICE = { fetch: async (request: Request) => { requests.push(request); return respond(request); } } as unknown as Fetcher;
  return { requests, client: createPlatformClient({ PLATFORM_SERVICE, PLATFORM_ORIGIN: "https://portal.test", PLATFORM_AGENT_TOKEN: "agent-token" }) };
}

test("submits JSON with the bearer token to the origin's submissions route and returns a rejected 201 as a receipt", async () => {
  const receipt = { submissionId: "evt-e1-0", state: "rejected", reason: "version_conflict",
    conflict: { currentVersionIdx: 0, availableDocumentContractIdxs: [0], threads: [] }, rejectedAt: AT };
  const { requests, client } = binding(() => Response.json(receipt, { status: 201 }));
  const body = { submissionId: "evt-e1-0", threadUpdates: [] };
  await expect(client.submit("t 1", "doc/1", body)).resolves.toEqual(receipt);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].url).toBe("https://portal.test/api/v1/tenants/t%201/documents/doc%2F1/submissions");
  expect(requests[0].headers.get("content-type")).toBe("application/json");
  expect(requests[0].headers.get("authorization")).toBe("Bearer agent-token");
  expect(await requests[0].json()).toEqual(body);
});

test("decodes the snapshot's content from canonical SValue CBOR", async () => {
  const { requests, client } = binding(() => new Response(encodeSValue({ content: "# 标题\n\n正文" }), { headers: { "content-type": "application/vnd.unidocs.dt-markdown.snapshot+cbor;version=1" } }));
  await expect(client.getSnapshotContent("t", "d", 2)).resolves.toBe("# 标题\n\n正文");
  expect(requests[0].url).toBe("https://portal.test/api/v1/tenants/t/documents/d/versions/2/snapshot");
  expect(requests[0].method).toBe("GET");
});

test("turns a non-2xx answer into an error carrying the status, and parses records with their schemas", async () => {
  const { client } = binding(request => request.url.endsWith("/threads/th")
    ? Response.json({ error: { code: "not_found" } }, { status: 404 })
    : Response.json({ documentId: "d", name: "n", documentType: "dt-markdown", currentVersionIdx: "zero", createdAt: AT }));
  await expect(client.getThread("t", "d", "th")).rejects.toMatchObject({ name: "PlatformRequestError", status: 404 });
  await expect(client.getThread("t", "d", "th")).rejects.toBeInstanceOf(PlatformRequestError);
  await expect(client.getDocument("t", "d")).rejects.toThrow();
});
