export {
  collectSBlobRefs,
  createSBlob,
  decodeSValueWithRefs,
  encodeSValueWithRefs,
  refsFromSValue,
} from "./svalue.js";

export { SValueContentType } from "./types.js";

export type {
  DecodedSValue,
  EncodedSValue,
  SValueCodecLimits,
  SValueCodecOptions,
} from "./svalue.js";