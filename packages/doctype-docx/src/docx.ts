/** DOCX DocumentType implementation over an immutable OpenXML Merkle manifest. */

import { Document } from "@ariadng/office/docx";
import { isSBlob } from "@unidocs/svalue-codec";
import type { DocumentTypeFactory, SBlob } from "@unidocs/protocol";
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
const PART_IO_CONCURRENCY = 8;

export const createDocxDocumentType: DocxDocumentTypeFactory = (context) => {
  const modelCache = new WeakMap<DocxDoc, Document>();

  async function materialize(doc: DocxDoc): Promise<Document> {
    const cached = modelCache.get(doc);
    if (cached) return cached;

    const loaded = await mapConcurrent(
      Object.entries(doc.files),
      PART_IO_CONCURRENCY,
      async ([path, blob]) => [path, await context.readSBlob(blob)] as const,
    );
    const files = Object.create(null) as Record<string, PackageFileData>;
    for (const [path, stored] of loaded) {
      Object.defineProperty(files, path, {
        enumerable: true,
        value: Object.freeze({ data: stored.data, contentType: stored.contentType }),
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
    const packageFiles = extracted ?? await extractOpenXmlPackage(await document.save());
    const stored = await mapConcurrent(
      Object.entries(packageFiles),
      PART_IO_CONCURRENCY,
      async ([path, file]) => {
        const blob = await context.makeSBlob({
          data: file.data,
          contentType: file.contentType,
        });
        const prior = previous?.files[path];
        return [path, prior?.hash === blob.hash ? prior : blob] as const;
      },
    );
    const files = Object.create(null) as Record<string, SBlob>;
    for (const [path, blob] of stored) {
      Object.defineProperty(files, path, { enumerable: true, value: blob });
    }
    const state = Object.freeze({
      kind: "openxml-package" as const,
      files: Object.freeze(files),
    });
    modelCache.set(state, document);
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
            await insertImage(working, operation.payload, context.readSBlob);
            break;
          case "deleteImage":
            deleteImage(working, operation.payload.index);
            break;
          case "replaceImage":
            await replaceImage(
              working,
              operation.payload.index,
              operation.payload.blob,
              context.readSBlob,
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
};

async function mapConcurrent<T, TResult>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index], index);
    }
  }
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}