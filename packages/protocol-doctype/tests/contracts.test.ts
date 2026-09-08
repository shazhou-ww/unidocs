import { describe, expect, expectTypeOf, it } from "vitest";
import { sBlobSignature } from "@unidocs/protocol";
import type { SBlob, SValueType } from "@unidocs/protocol";
import {
  createChangeSet, createStateSource, isEditorContext, isSBlobReference,
  isOperatorSession, isServiceResult, isStateSource, serviceFailure, serviceSuccess,
} from "../src/index.js";
import type { EditorEndpointContracts, OperatorEndpointContracts, StateSource } from "../src/index.js";

interface TextOperation { readonly text: string }
interface TextDocument { readonly content: string }
const isText = (value: unknown): value is string => typeof value === "string";
const isOperation = (value: unknown): value is TextOperation =>
  value !== null && typeof value === "object" && "text" in value && typeof value.text === "string";
const blob: SBlob = { [sBlobSignature]: true, hash: "opaque-cas-hash" };

describe("state sources", () => {
  it("preserves a fixed base and ordered operations without aliasing arrays", () => {
    const operations = [{ text: "first" }, { text: "second" }];
    const changes = [createChangeSet<TextOperation>(operations)];
    const source = createStateSource<TextOperation>("markdown/1", blob, changes);
    operations.reverse();
    changes.length = 0;
    expect(source.changes[0].operations).toEqual([{ text: "first" }, { text: "second" }]);
    expect(source.base).toBe(blob);
    expect(isStateSource<TextOperation>(source, isOperation)).toBe(true);
    expect(isStateSource<TextOperation>(createStateSource("markdown/1", null, []), isOperation)).toBe(true);
  });

  it.each([
    { schemaVersion: "markdown/1", base: "hash", changes: [] },
    { schemaVersion: "markdown/1", base: { hash: "hash" }, changes: [] },
    { schemaVersion: "markdown/1", base: { content: "inline" }, changes: [] },
    { schemaVersion: "markdown/1", changes: [] },
    { schemaVersion: "", base: null, changes: [] },
    { schemaVersion: "markdown/1", base: null, changes: [{ operations: [42] }] },
    { schemaVersion: "markdown/1", base: null, changes: [], token: "unexpected" },
    { schemaVersion: "markdown/1", base: null, changes: new Array(1) },
    { schemaVersion: "markdown/1", base: null, changes: [{ operations: new Array(1) }] },
  ])("rejects ambiguous or malformed sources: %j", (value) => {
    expect(isStateSource<TextOperation>(value, isOperation)).toBe(false);
  });

  it("recognizes branded references, not JSON hash lookalikes", () => {
    expect(isSBlobReference(blob)).toBe(true);
    expect(isSBlobReference({ hash: blob.hash })).toBe(false);
  });
});

describe("results and contexts", () => {
  it("keeps operator sessions independent of editor contexts", () => {
    expect(isOperatorSession({ operatorSessionId: "operator", generation: 0 })).toBe(true);
    expect(isOperatorSession({ operatorSessionId: "operator", generation: -1 })).toBe(false);
    expect(isOperatorSession({ contextId: "editor", sequence: 0 })).toBe(false);
    expect(isEditorContext({ operatorSessionId: "operator", generation: 0 })).toBe(false);
  });

  it("constructs and checks explicit success and failure envelopes", () => {
    expect(isServiceResult(serviceSuccess<string>("done"), isText)).toBe(true);
    expect(isServiceResult(serviceFailure("context_lost", "Reinitialize"), isText)).toBe(true);
    expect(isServiceResult({ success: true, data: 42 }, isText)).toBe(false);
    expect(isServiceResult({ success: false, error: { code: "made_up", message: "no" } }, isText)).toBe(false);
    expect(isServiceResult({ success: true, data: "ok", error: "ambiguous" }, isText)).toBe(false);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid sequence %s", (sequence) => {
    expect(isEditorContext({ contextId: "context", sequence })).toBe(false);
  });

  it("distinguishes temporary contexts from persistent versions", () => {
    expect(isEditorContext({ contextId: "context", sequence: 0 })).toBe(true);
    expect(isEditorContext({ contextId: "context", version: 1 })).toBe(false);
    expect(isEditorContext({ contextId: "context", sequence: 0, version: 1 })).toBe(false);
  });
});

describe("type contracts", () => {
  it("supports typed SValue interfaces and keeps editor/operator endpoints separate", () => {
    type Editor = EditorEndpointContracts<TextDocument, string, TextOperation>;
    expectTypeOf<Editor["init"]["request"]["body"]["source"]>().toEqualTypeOf<StateSource<TextOperation>>();
    expectTypeOf<Editor["snapshot"]["response"]["body"]>().toEqualTypeOf<
      { readonly success: true; readonly data: TextDocument }
      | { readonly success: false; readonly error: import("../src/index.js").ServiceError }
    >();
    expectTypeOf<SValueType<Editor["apply"]["request"]["body"]>>().not.toBeNever();
    expectTypeOf<SValueType<OperatorEndpointContracts["run"]["request"]["body"]>>().not.toBeNever();
    expectTypeOf<keyof Editor>().toEqualTypeOf<"init" | "import" | "query" | "apply" | "snapshot" | "export" | "summary">();
    expectTypeOf<keyof OperatorEndpointContracts>().toEqualTypeOf<"run" | "reset">();
    expectTypeOf<Editor["init"]["request"]["headers"]["authentication"]["role"]>().toEqualTypeOf<"editor">();
    expectTypeOf<OperatorEndpointContracts["run"]["request"]["headers"]["authentication"]["role"]>().toEqualTypeOf<"operator">();
    expectTypeOf<OperatorEndpointContracts["run"]["request"]["headers"]["platformAuthorization"]>().toEqualTypeOf<string>();
    expectTypeOf<SValueType<{ readonly invalid: Date }>>().toBeNever();
    expectTypeOf<EditorEndpointContracts<Date>["snapshot"]["response"]["body"]>().toEqualTypeOf<
      { readonly success: true; readonly data: never }
      | { readonly success: false; readonly error: import("../src/index.js").ServiceError }
    >();
  });
});