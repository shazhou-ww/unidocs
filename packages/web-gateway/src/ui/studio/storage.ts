import type { DraftCheckpoint } from "@unidocs/psd-client";
import type { PsdDoc } from "@unidocs/doctype-psd/engine";

export type StudioSnapshot = {
  schema: 1;
  versions: Array<{ version: number; doc: PsdDoc }>;
  draft: DraftCheckpoint;
  editing: boolean;
  viewVersion: number;
};

export type StudioRecord = { revision: number; snapshot: StudioSnapshot };
const recordKey = "public-local-sample";

export class StudioStorage {
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = "unidocs-local-studio-v1") { }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("浏览器不支持本地存储")); return; }
      const request = this.factory.open(this.name, 1);
      let blocked = false;
      request.onupgradeneeded = () => { request.result.createObjectStore("workspace"); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error("本地存储升级被其他页面阻止，请关闭旧页面")); };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  async load(): Promise<StudioRecord | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readonly");
      const request = transaction.objectStore("workspace").get(recordKey);
      transaction.oncomplete = () => {
        database.close();
        const record = request.result as StudioRecord | undefined;
        if (record && (record.snapshot?.schema !== 1 || !Number.isSafeInteger(record.revision))) {
          reject(new Error("本地记录格式不兼容，原数据未改动")); return;
        }
        resolve(record ?? null);
      };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("读取本地记录失败")); };
    });
  }

  async save(snapshot: StudioSnapshot, expectedRevision: number): Promise<number> {
    const payload = structuredClone(snapshot);
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const objectStore = transaction.objectStore("workspace");
      const current = objectStore.get(recordKey);
      let failure: Error | null = null;
      current.onsuccess = () => {
        if ((current.result?.revision ?? 0) !== expectedRevision) {
          failure = new Error("另一页面已更新本地作品。当前草稿仍在内存，请先下载画面；刷新后读取已存版本。");
          transaction.abort(); return;
        }
        try { objectStore.put({ revision: expectedRevision + 1, snapshot: payload }, recordKey); }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); transaction.abort(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(expectedRevision + 1); };
      transaction.onabort = () => { database.close(); reject(failure ?? transaction.error ?? new Error("本地存储失败，当前修改尚未持久化")); };
    });
  }
}