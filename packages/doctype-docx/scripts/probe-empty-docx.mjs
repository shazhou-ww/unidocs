import { Document } from "@ariadng/office/docx";

const doc = Document.create();
const bytes = await doc.save();
console.log("empty docx package bytes:", bytes.length);
console.log("first bytes:", bytes.subarray(0, 4).toString("hex"), "(PK = zip)");
