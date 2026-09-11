/**
 * hash 路由。定位链接不携带 JWT、不授予权限——它只是「打开哪一处」。
 */
export type Route =
  | { readonly kind: "workbench" }
  | {
      readonly kind: "document";
      readonly documentId: string;
      readonly threadId?: string;
      readonly pingIdx?: number;
    };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  if (path === "") return { kind: "workbench" };

  const parts = path.split("/").map((segment) => decodeURIComponent(segment));
  if (parts[0] !== "d" || parts[1] === undefined || parts[1] === "") return { kind: "workbench" };

  const documentId = parts[1];
  if (parts[2] === undefined) return { kind: "document", documentId };

  const threadId = parts[2];
  if (parts[3] === undefined) return { kind: "document", documentId, threadId };

  const pingIdx = Number(parts[3]);
  if (!Number.isInteger(pingIdx) || pingIdx < 0) return { kind: "document", documentId, threadId };
  return { kind: "document", documentId, threadId, pingIdx };
}

export function routeToHash(route: Route): string {
  if (route.kind === "workbench") return "#/";
  const parts = ["d", route.documentId];
  if (route.threadId !== undefined) parts.push(route.threadId);
  if (route.pingIdx !== undefined) parts.push(String(route.pingIdx));
  return `#/${parts.map((segment) => encodeURIComponent(segment)).join("/")}`;
}
