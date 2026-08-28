/**
 * @unidocs/protocol — Cloud-neutral document protocol contracts.
 *
 * Pure type definitions and protocol constants only — no logic, no I/O.
 * The SValue/SBlob codec lives in @unidocs/svalue-codec, which
 * depends on this package for its types.
 */

export type {
  AgentToolDefinition,
  AgentContentPart,
  AgentToolResult,
  CasRef,
  CasReferences,
  CasReadContext,
  DocumentFormat,
  DocumentType,
  DocumentTypeContext,
  DocumentTypeFactory,
  MakeSBlob,
  JsonPrimitive,
  JsonValue,
  QueryPrimitive,
  QueryValue,
  SBlob,
  SBlobData,
  SPrimitive,
  SValue,
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
  sBlobSignature,
  SBlobTag,
  SValueContentType,
} from "./types.js";
