/**
 * @unidocs/protocol — Cloud-neutral document protocol contracts.
 *
 * Pure type definitions, protocol constants, and deterministic wire-format helpers only — no I/O.
 * The SValue/SBlob codec lives in @unidocs/svalue-codec, which
 * depends on this package for its types.
 */

export type {
  AgentToolDefinition,
  AgentContentPart,
  ByteStream,
  AgentToolResult,
  CasRef,
  CasReferences,
  CasReadContext,
  DocumentFormat,
  DocumentType,
  DocumentTypeContext,
  DocumentMemoryProbe,
  DocumentMemoryProbeSample,
  DocumentTypeFactory,
  EffectContext,
  EffectOutcome,
  MakeSBlob,
  JsonPrimitive,
  JsonValue,
  QueryPrimitive,
  QueryValue,
  SBlob,
  SBlobData,
  SBlobBytes,
  SBlobHandler,
  SBlobReadRange,
  SBlobSource,
  SPrimitive,
  SValue,
  SValueSchema,
  SValueShape,
  SValueType,
  DecodedSValue,
  EncodedSValue,
  SValueCodecLimits,
  SValueCodecOptions,
  AgentTool,
  DocumentAgent,
  AgentPlatform,
  AgentToolCall,
  AgentMessage,
  LlmContentPart,
  LlmMessage,
  AgentCompletion,
  LlmProvider,
} from "./types.js";

export {
  BlobUnavailableError,
  DocumentContentFormatVersion,
  DocumentTypePattern,
  documentLocationContentType,
  documentSnapshotContentType,
  sBlobSignature,
  SBlobTag,
  SValueContentType,
  SValueSchemaDialect,
} from "./types.js";
export type { DocumentLocationContentType, DocumentSnapshotContentType } from "./types.js";
