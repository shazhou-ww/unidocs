# Replace an Operator

Replace an Operator by validating and persisting a new resource, then updating the document type binding. Do not mutate the old Operator's discovery identity or base URL.

## 1. Validate the candidate

Submit the new base URL and expected document type. Confirm the captured `declaredOperatorId`, discovery descriptor, supported Document Contract revisions, external configuration ETag, and validation expiry.

## 2. Persist before expiry

Persist the successful validation as a Platform Operator. This produces a new Platform `operatorId`; it does not reuse the service-declared identity and does not select the Operator.

## 3. Verify compatibility

Compare the new Operator's supported revisions with the current View bundle. The intersection must remain non-empty for an enabled format. If necessary, stage a compatible View replacement and switch both resources in one document type update.

## 4. Bind conditionally

Read the latest document type ETag and PATCH `operatorId` with a clear reason. On a precondition failure, reconcile current bindings before retrying.

## 5. Observe and recover

Inspect audit events and runtime health. Recovery selects the previous immutable Operator resource with another conditional update; it does not rewrite either Operator descriptor.
