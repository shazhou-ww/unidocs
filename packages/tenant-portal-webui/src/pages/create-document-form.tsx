/**
 * 工作台的「新建文档」。类型来自 listPublicDocumentTypes（只列当前可建的类型），
 * 建成后文档还没有版本——跳到文档页，由那里等 Operator 写出第一版（R17）。
 *
 * 幂等：同一次提交的重试沿用同一个 idempotency key，服务端把它当成同一次创建，
 * 不会因为网络抖动建出两份。key 跟着请求体走：名称或类型一改就是另一次创建，
 * 换新 key——沿用旧 key 发不同内容，服务端会判为冲突。
 */
import { useEffect, useRef, useState } from "react";
import type { PublicDocumentType } from "@unidocs/protocol-tenant-portal";
import { useClient } from "../client-context.js";
import { errorText } from "../error-text.js";
import { routeToHash } from "../router.js";

/** typeCard.locales 按 zh → en → 第一个键取显示名。 */
export function documentTypeDisplayName(type: PublicDocumentType): string {
  const locales = type.typeCard.locales;
  const locale = locales.zh ?? locales.en ?? Object.values(locales)[0];
  return locale?.name ?? type.documentType;
}

export function CreateDocumentForm(props: { onCancel(): void }) {
  const client = useClient();
  const [types, setTypes] = useState<readonly PublicDocumentType[] | null>(null);
  const [name, setName] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const attempt = useRef<{ readonly body: string; readonly key: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.listPublicDocumentTypes()
      .then((page) => {
        if (cancelled) return;
        setTypes(page.items);
        if (page.items.length === 1) setDocumentType(page.items[0].documentType);
      })
      .catch((cause: unknown) => { if (!cancelled) setFailure(errorText(cause)); });
    return () => { cancelled = true; };
  }, [client]);

  const trimmed = name.trim();
  const canSubmit = !submitting && trimmed !== "" && documentType !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    const body = { documentType, name: trimmed };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.body !== fingerprint) attempt.current = { body: fingerprint, key: crypto.randomUUID() };

    setSubmitting(true);
    setFailure(null);
    try {
      const created = await client.createDocument(attempt.current.key, body);
      window.location.hash = routeToHash({ kind: "document", documentId: created.documentId });
    } catch (cause) {
      setFailure(errorText(cause));
      setSubmitting(false);
    }
  };

  return (
    <form className="create-document" aria-label="新建文档" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label className="field-label" htmlFor="create-document-name">名称</label>
        <input
          id="create-document-name"
          value={name}
          maxLength={200}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="create-document-type">文档类型</label>
        <select
          id="create-document-type"
          value={documentType}
          disabled={types === null || types.length === 0}
          onChange={(event) => setDocumentType(event.target.value)}
        >
          {types !== null && types.length !== 1 && (
            <option value="" disabled>{types.length === 0 ? "暂无可用的类型" : "选择类型"}</option>
          )}
          {(types ?? []).map((type) => (
            <option key={type.documentType} value={type.documentType}>{documentTypeDisplayName(type)}</option>
          ))}
        </select>
      </div>
      {failure !== null && <p role="alert" className="create-document-error">{failure}</p>}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="primary" disabled={!canSubmit}>{submitting ? "正在创建…" : "创建"}</button>
        <button type="button" onClick={props.onCancel}>取消</button>
      </div>
    </form>
  );
}
