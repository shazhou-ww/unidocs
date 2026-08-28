/**
 * @unidocs/svalue-codec — SValue/SBlob codec and doctype protocol
 * helpers. Cloud-neutral. Pure protocol types live in @unidocs/protocol.
 */

export { toJsonValue } from "./json.js";

export {
	collectSBlobRefs,
	createSBlob,
	decodeSValue,
	encodeSValue,
	isSBlob,
	refsFromSValue,
	requireNumber,
	requireNumberArray,
	requireRecord,
	requireSBlob,
	requireString,
} from "./svalue.js";
