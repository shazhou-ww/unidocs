# Evolve a document format

Evolve schemas by appending a Document Contract. Never edit a historical revision or repurpose its index.

## 1. Design the paired change

Define the complete snapshot schema and location schema for the new revision. Even when only one side changes, append both as one pair so every index remains self-contained.

## 2. Check component support

Prepare a View and Operator that explicitly support the new index. They may continue to support older revisions. The usable set is always the intersection of the currently bound View and Operator declarations.

## 3. Append the contract

Append the paired schemas to the document type. The Platform assigns the next zero-based `DocumentContractIdx`. This operation is allowed while the type is enabled and does not automatically alter current bindings.

## 4. Stage and select compatible resources

Upload or validate replacements as candidates. Then conditionally update the document type to select a compatible View and Operator. You may deploy them together or in phases while their supported sets retain a non-empty intersection.

## 5. Preserve history

Existing document versions keep their original contract index. New proposals may use any revision supported by both current components; the highest index is informational rather than a global current-schema pointer.
