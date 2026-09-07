import { createContext } from "react";
import { clearBrowserCasNodeCaches, createBrowserCasNodeCache, type BrowserCasNodeCache } from "@unicas/tenant-browser-cache";

export interface PlaygroundCacheSession {
  get(endpoint: string): BrowserCasNodeCache | undefined;
  clear(): Promise<void>;
  close(): void;
}

export const PlaygroundCacheContext = createContext<PlaygroundCacheSession | null>(null);

export function createPlaygroundCacheSession(identity: { identityIssuer: string; subject: string }): PlaygroundCacheSession {
  const caches = new Map<string, BrowserCasNodeCache>();
  const principal = JSON.stringify([identity.identityIssuer, identity.subject]);
  let closed = false;
  return {
    get(endpoint) {
      if (closed || !identity.identityIssuer || !identity.subject) return undefined;
      let cache = caches.get(endpoint);
      if (!cache) {
        cache = createBrowserCasNodeCache({ namespace: { endpoint, principal } });
        caches.set(endpoint, cache);
      }
      return cache;
    },
    async clear() {
      closed = true;
      try { await clearBrowserCasNodeCaches({ principal }); }
      finally {
        for (const cache of caches.values()) cache.close();
        caches.clear();
      }
    },
    close() {
      closed = true;
      for (const cache of caches.values()) cache.close();
      caches.clear();
    },
  };
}