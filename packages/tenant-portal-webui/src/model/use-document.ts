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
          setState({
            document: null, currentVersion: null, summary: null, loading: false,
            failure: cause instanceof Error ? cause : new Error("加载失败"),
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [client, documentId, epoch]);

  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  return { ...state, reload };
}
