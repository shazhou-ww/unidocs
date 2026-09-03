/** DOCX DocumentType implementation over an immutable OpenXML Merkle manifest. */

import { Document } from "@ariadng/office/docx";
import { isSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeFactory, SBlob, SBlobHandler } from "@unidocs/protocol";
import {
  insertImage,
  deleteImage,
  replaceImage,
  setImageSize,
  setImageAltText,
} from "./ops/image-ops.js";
import { appendParagraph, setRunText } from "./ops/paragraph-ops.js";
import { addTable, addTableRow, setCellText } from "./ops/table-ops.js";
import { addBulletList, addNumberedList } from "./ops/list-ops.js";
import { setFooter, setHeader } from "./ops/section-ops.js";
import {
  extractOpenXmlPackage,
  DEFAULT_OPEN_XML_PACKAGE_BYTES,
  DEFAULT_OPEN_XML_PART_BYTES,
  materializeDocxPackage,
  openDocxPackage,
} from "./package-adapter.js";
import type { PackageFileData } from "./package-adapter.js";
import { executeQuery } from "./queries.js";
import type { DocxDoc, DocxOperation, DocxQuery } from "./types.js";

export type DocxDocumentTypeFactory = DocumentTypeFactory<
  DocxDoc,
  DocxQuery,
  DocxOperation
>;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const createDocxDocumentType: DocxDocumentTypeFactory = (context) => {
  const modelCache = new WeakMap<DocxDoc, Document>();

  async function materialize(doc: DocxDoc): Promise<Document> {
    const cached = modelCache.get(doc);
    if (cached) return cached;

    // 并发上限由 SBlob 客户端统一持有,这里不再自己限一层 —— 理由见 storeState。
    const loaded = await Promise.all(
      Object.entries(doc.files).map(
        async ([path, blob]) => [path, await context.openSBlob(blob)] as const,
      ),
    );
    let packageBytes = 0;
    for (const [path, handler] of loaded) {
      if (handler.size > DEFAULT_OPEN_XML_PART_BYTES) {
        throw new Error(`OpenXML part ${path} exceeds ${DEFAULT_OPEN_XML_PART_BYTES} bytes`);
      }
      packageBytes += handler.size;
      if (!Number.isSafeInteger(packageBytes) || packageBytes > DEFAULT_OPEN_XML_PACKAGE_BYTES) {
        throw new Error(`OpenXML package exceeds ${DEFAULT_OPEN_XML_PACKAGE_BYTES} uncompressed bytes`);
      }
    }
    const files = Object.create(null) as Record<string, PackageFileData>;
    for (const [path, handler] of loaded) {
      Object.defineProperty(files, path, {
        enumerable: true,
        value: Object.freeze({
          data: await materializeHandler(handler, DEFAULT_OPEN_XML_PART_BYTES),
          contentType: handler.contentType,
        }),
      });
    }
    const document = await materializeDocxPackage(files);
    modelCache.set(doc, document);
    return document;
  }

  async function storeState(
    document: Document,
    previous?: DocxDoc,
    extracted?: Readonly<Record<string, PackageFileData>>,
  ): Promise<DocxDoc> {
    context.memoryProbe?.({ stage: "docx.store.start" });
    let packageFiles = extracted;
    if (packageFiles === undefined) {
      const packageBytes = await document.save();
      context.memoryProbe?.({
        stage: "docx.package.saved",
        details: { packageBytes: packageBytes.length },
      });
      packageFiles = await extractOpenXmlPackage(packageBytes);
    }
    const packageEntries = Object.entries(packageFiles);
    const partBytes = packageEntries.reduce((total, [, file]) => total + file.data.length, 0);
    context.memoryProbe?.({
      stage: "docx.package.extracted",
      details: { partCount: packageEntries.length, partBytes },
    });
    // 这里曾经是 `PART_IO_CONCURRENCY = 2` 的本地限流(0795252)。它限的其实就是
    // `openSBlob`/`makeSBlob` —— CAS 调用本身,和 sblob-context 里那条为躲同一个
    // OOM 而退化出的串行是同一个资源,只是各限各的。上限现在由 SBlob 客户端统一
    // 持有(`SBlobContextOptions.casConcurrency`),doctype 不再自带一份:两层套着
    // 只有紧的那层生效,而 doctype 侧那份既拿不到运行时的正确取值(CF 的 DO
    // isolate 和 Azure 差一个数量级),也让"上限到底是多少"失去单一出处。
    context.memoryProbe?.({
      stage: "docx.parts.upload.start",
      details: { partCount: packageEntries.length, partBytes },
    });
    const stored = await Promise.all(
      packageEntries.map(async ([path, file]) => {
        const blob = await context.makeSBlob({
          data: file.data,
          contentType: file.contentType,
        });
        const prior = previous?.files[path];
        return [path, prior?.hash === blob.hash ? prior : blob] as const;
      }),
    );
    context.memoryProbe?.({
      stage: "docx.parts.upload.complete",
      details: { partCount: stored.length, partBytes },
    });
    const files = Object.create(null) as Record<string, SBlob>;
    for (const [path, blob] of stored) {
      Object.defineProperty(files, path, { enumerable: true, value: blob });
    }
    const state = Object.freeze({
      kind: "openxml-package" as const,
      files: Object.freeze(files),
    });
    modelCache.set(state, document);
    context.memoryProbe?.({
      stage: "docx.store.complete",
      details: { partCount: stored.length },
    });
    return state;
  }

  return {
    init: async () => storeState(Document.create()),

    query: async (query, doc) => {
      const document = await materialize(doc);
      if (query.kind === "getImageContent") {
        const metadata = executeQuery({
          kind: "getImage",
          payload: query.payload,
        }, document);
        if (metadata === null
          || typeof metadata !== "object"
          || Array.isArray(metadata)
          || isSBlob(metadata)) {
          throw new Error(`Image ${query.payload.index} has no metadata`);
        }
        const record = metadata as { readonly [key: string]: import("@unidocs/protocol").SValue };
        const partName = record.partName;
        if (typeof partName !== "string") {
          throw new Error(`Image ${query.payload.index} has no package part`);
        }
        const blob = doc.files[partName];
        if (!blob) throw new Error(`Image package part is missing from manifest: ${partName}`);
        return { ...record, blob };
      }
      return executeQuery(query, document);
    },

    apply: async (operations, doc) => {
      const source = await materialize(doc);
      const working = await Document.open(await source.save());

      for (const operation of operations) {
        switch (operation.kind) {
          case "appendParagraph":
            appendParagraph(working, operation.payload.text, operation.payload.options);
            break;
          case "setRunText":
            setRunText(
              working,
              operation.payload.paragraphIndex,
              operation.payload.runIndex,
              operation.payload.text,
            );
            break;
          case "addTable":
            addTable(
              working,
              operation.payload.rows,
              operation.payload.cols,
              operation.payload.style,
              operation.payload.widthsTwips,
            );
            break;
          case "setCellText":
            setCellText(
              working,
              operation.payload.tableIndex,
              operation.payload.row,
              operation.payload.col,
              operation.payload.text,
            );
            break;
          case "addTableRow":
            addTableRow(working, operation.payload.tableIndex);
            break;
          case "addBulletList":
            addBulletList(working, operation.payload.items);
            break;
          case "addNumberedList":
            addNumberedList(working, operation.payload.items, operation.payload.format);
            break;
          case "setHeader":
            setHeader(working, operation.payload.text, operation.payload.type);
            break;
          case "setFooter":
            setFooter(working, operation.payload.text, operation.payload.type);
            break;
          case "insertImage":
            await insertImage(working, operation.payload, readBlobBytes);
            break;
          case "deleteImage":
            deleteImage(working, operation.payload.index);
            break;
          case "replaceImage":
            await replaceImage(
              working,
              operation.payload.index,
              operation.payload.blob,
              readBlobBytes,
            );
            break;
          case "setImageSize":
            setImageSize(
              working,
              operation.payload.index,
              operation.payload.widthEmu,
              operation.payload.heightEmu,
            );
            break;
          case "setImageAltText":
            setImageAltText(working, operation.payload.index, operation.payload.altText);
            break;
        }
      }

      return storeState(working, doc);
    },

    formats: {
      docx: {
        mediaTypes: [DOCX_CONTENT_TYPE],
        extensions: [".docx"],
        load: async (data) => {
          const opened = await openDocxPackage(data);
          return storeState(opened.document, undefined, opened.files);
        },
        save: async (doc) => (await materialize(doc)).save(),
      },
    },
    defaultFormat: "docx",

    contentType: DOCX_CONTENT_TYPE,
  };

  async function readBlobBytes(blob: SBlob): Promise<Uint8Array> {
    return materializeHandler(await context.openSBlob(blob), DEFAULT_OPEN_XML_PART_BYTES);
  }
};

async function materializeHandler(handler: SBlobHandler, maxBytes: number): Promise<Uint8Array> {
  if (handler.size > maxBytes) throw new Error(`SBlob exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(handler.size);
  let offset = 0;
  for await (const chunk of handler.read()) {
    if (offset + chunk.length > bytes.length) throw new Error("SBlob returned more bytes than declared");
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== bytes.length) throw new Error(`SBlob returned ${offset} bytes, expected ${bytes.length}`);
  return bytes;
}
