import { useCallback, useMemo, useState } from "react";
import { anchorKeyOf, createDraftStore, type Draft } from "./draft-store.js";

export interface DraftsApi {
  readonly drafts: readonly Draft[];
  readonly count: number;
  draftsForAnchor(anchorKey: string): readonly Draft[];
  saveDraft(input: {
    draftId?: string;
    threadId: string | null;
    location: Draft["location"];
    baseVersionIdx: number;
    text: string;
    editedFromPingIdx?: number | null;
  }): Draft;
  removeDraft(draftId: string): void;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function useDrafts(documentId: string): DraftsApi {
  const store = useMemo(() => createDraftStore(globalThis.localStorage), []);
  const [epoch, setEpoch] = useState(0);

  const drafts = useMemo(
    () => store.listForDocument(documentId),
    // epoch 参与依赖，让写入后重新读一遍。
    [store, documentId, epoch],
  );

  const saveDraft = useCallback<DraftsApi["saveDraft"]>((input) => {
    const draftId = input.draftId ?? newId();
    const draft: Draft = {
      draftId,
      documentId,
      anchorKey: anchorKeyOf({ threadId: input.threadId, location: input.location }),
      threadId: input.threadId,
      location: input.location,
      baseVersionIdx: input.baseVersionIdx,
      text: input.text,
      idempotencyKey: newId(),
      editedFromPingIdx: input.editedFromPingIdx ?? null,
      updatedAt: new Date().toISOString(),
    };
    store.save(draft);
    setEpoch((value) => value + 1);
    return store.list().find((candidate) => candidate.draftId === draftId) ?? draft;
  }, [store, documentId]);

  const removeDraft = useCallback((draftId: string) => {
    store.remove(draftId);
    setEpoch((value) => value + 1);
  }, [store]);

  return {
    drafts,
    count: drafts.length,
    draftsForAnchor: (anchorKey) => drafts.filter((draft) => draft.anchorKey === anchorKey),
    saveDraft,
    removeDraft,
  };
}
