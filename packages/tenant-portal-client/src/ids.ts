/**
 * Wire primitive identifiers shared across this client.
 *
 * @unidocs/protocol-tenant-portal validates these over the wire with Zod
 * schemas (`IdSchema`, `VersionIdxSchema`, `CommentIdxSchema`, ...), but only
 * exports the schemas and the composite record types built from them — it does
 * not export narrow TypeScript aliases for the primitives themselves. These
 * mirror the same wire shapes (a non-empty string id, a zero-based safe
 * integer index) so this client's public API stays readable.
 */
export type TenantId = string;
export type DocumentId = string;
export type DocumentType = string;
export type ThreadId = string;
export type DocumentContractIdx = number;
export type VersionIdx = number;
export type CommentIdx = number;
export type ReplyIdx = number;
