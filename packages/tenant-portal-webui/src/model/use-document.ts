import { useCallback, useEffect, useState } from "react";
import type { DocumentRecord, VersionRecord } from "@unidocs/protocol-platform";
import { PlatformError } from "@unidocs/tenant-portal-client";
import { useClient } from "../client-context.js";
import { loadDiscussionSummary, type DiscussionSummary } from "./discussion-summary.js";

export interface DocumentSession {
  readonly document: DocumentRecord | null;
  readonly currentVersion: VersionRecord | null;
  readonly summary: DiscussionSummary | null;
  readonly failure: PlatformError | Error | null;
  readonly loading: boolean;
  reload(): void;
}

export function useDocumentSession(documentId: string): DocumentSession {
  const client = useClient();
  const [state, setState] = useState<Omit<DocumentSession, "reload">>({
    document: null, currentVersion: null, summary: null, failure: null, loading: true,
  });
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true }));

    void (async () => {
      try {
        const document = await client.getDocument(documentId);
        const currentVersion = document.currentVersionIdx === null
          ? null
          : await client.getVersion(documentId, document.currentVersionIdx);
        const summary = await loadDiscussionSummary(client, documentId);
        if (!cancelled) setState({ document, currentVersion, summary, failure: null, loading: false });
      } catch (cause) {
        if (!cancelled) {
          const failure = cause instanceof Error ? cause : new Error("加载失败");
          // 只有首次加载（还没有任何内容可看）失败才整页置空——那种情况没有旧内容
          // 可以保留，只能显示全屏错误。一旦曾经成功过，之后任何一次 reload() 失败
          // 都保留上一次成功的 document/currentVersion/summary，只把失败记下来，
          // 交给页面用一条不影响已有内容的提示条展示（document.tsx 的 carry-forward 1）。
          setState((previous) => ({
            ...previous,
            failure,
            loading: false,
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [client, documentId, epoch]);

  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  return { ...state, reload };
}
