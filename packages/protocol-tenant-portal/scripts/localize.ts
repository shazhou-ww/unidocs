/**
 * Translate a generated OpenAPI document by overlaying prose strings.
 *
 * oRPC inlines every schema, so the same field description appears in many
 * operations and there is no stable path to key a translation on. Keying by the
 * exact English string instead makes one entry cover all of them, and makes a
 * reworded contract surface as a missing translation rather than stale Chinese.
 */

/** Response descriptions oRPC derives from the status code carry no prose. */
const StatusDescriptionPattern = /^(OK|\d{3})$/;

const ProseKeys = new Set(["description", "summary"]);

function isProse(key: string, value: unknown): value is string {
  return ProseKeys.has(key) && typeof value === "string"
    && !StatusDescriptionPattern.test(value);
}

function mapProse(value: unknown, translate: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapProse(item, translate));
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isProse(key, child) ? translate(child) : mapProse(child, translate),
    ]),
  );
}

/** Every prose string in the document, deduplicated, in document order. */
export function collectProseStrings(document: unknown): string[] {
  const found = new Set<string>();
  mapProse(document, (text) => {
    found.add(text);
    return text;
  });
  return [...found];
}

/** Prose strings the table does not translate. */
export function missingTranslations(
  document: unknown,
  table: Readonly<Record<string, string>>,
): string[] {
  return collectProseStrings(document).filter((text) => table[text] === undefined);
}

export interface ReferenceTranslation {
  readonly prose: Readonly<Record<string, string>>;
  /** Tag names, which are both navigation headings and operation references. */
  readonly tagNames: Readonly<Record<string, string>>;
}

interface TaggedDocument {
  readonly tags?: readonly { readonly name: string }[];
  readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Tag names used by the document, deduplicated. */
export function collectTagNames(document: unknown): string[] {
  const tagged = document as TaggedDocument;
  const found = new Set<string>((tagged.tags ?? []).map((tag) => tag.name));
  for (const item of Object.values(tagged.paths ?? {})) {
    for (const operation of Object.values(item)) {
      const tags = (operation as { tags?: readonly string[] } | null)?.tags ?? [];
      for (const tag of tags) found.add(tag);
    }
  }
  return [...found];
}

/**
 * Rename tags in the only two places OpenAPI names them: the document's tag
 * list, and each operation's tag references. They must move together, or an
 * operation ends up filed under a heading the document never declares.
 */
function renameTags<TDocument>(
  document: TDocument,
  tagNames: Readonly<Record<string, string>>,
): TDocument {
  const rename = (tag: string) => tagNames[tag] ?? tag;
  const tagged = document as TDocument & TaggedDocument;

  const paths = Object.fromEntries(
    Object.entries(tagged.paths ?? {}).map(([path, item]) => [
      path,
      Object.fromEntries(Object.entries(item).map(([method, operation]) => {
        const tags = (operation as { tags?: readonly string[] } | null)?.tags;
        return [
          method,
          tags === undefined ? operation : { ...(operation as object), tags: tags.map(rename) },
        ];
      })),
    ]),
  );

  return {
    ...tagged,
    ...(tagged.tags === undefined
      ? {}
      : { tags: tagged.tags.map((tag) => ({ ...tag, name: rename(tag.name) })) }),
    ...(tagged.paths === undefined ? {} : { paths }),
  };
}

/**
 * Return a copy of the document with every prose string and tag name
 * translated. Throws when the tables are incomplete, so an untranslated
 * operation fails generation instead of shipping a half-translated reference.
 */
export function localizeDocument<TDocument>(
  document: TDocument,
  translation: ReferenceTranslation,
): TDocument {
  const missing = [
    ...missingTranslations(document, translation.prose),
    ...collectTagNames(document).filter((tag) => translation.tagNames[tag] === undefined),
  ];
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} untranslated string(s):\n${
        missing.map((text) => `  ${JSON.stringify(text)}`).join("\n")
      }`,
    );
  }

  const translated = mapProse(document, (text) => translation.prose[text] ?? text) as TDocument;
  return renameTags(translated, translation.tagNames);
}
