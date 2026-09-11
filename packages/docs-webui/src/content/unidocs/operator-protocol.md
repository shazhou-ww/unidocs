# Implement an Operator

An Operator is an external service that understands one or more document formats and can participate in document processing. Admin onboarding and runtime collaboration are separate protocol boundaries.

## Discovery descriptor

The Operator exposes a public discovery descriptor using protocol `unidocs-operator/v1`. It declares:

- a stable `declaredOperatorId` owned by the service;
- a display name;
- supported document types;
- supported Document Contract revisions for each type.

The declared service identity is not the same as the Platform-assigned persistent `operatorId`.

## Admin validation

The administrator submits the Operator base URL and expected document type. The Platform fetches discovery and performs a signed, user-data-free probe with bounded requests, no redirects, and no private-network destination.

Success returns a short-lived immutable validation record containing the captured descriptor, external configuration ETag, validation time, and expiry. Failures create no validation resource but are recorded in audit.

## Persist the Operator

Persist a current validation to create a Platform Operator resource. The validated base URL and discovery descriptor become immutable. Administrator-facing name and description remain editable under the resource ETag.

Persistence does not bind the Operator to a document type. Binding is a separate document type update.

## Runtime relationship

At runtime, the Platform remains authoritative for documents, versions, comments, and submissions. Operator registration does not grant an exclusive document lease. The Platform notifies the selected Operator, the Operator queries authorized state, and it submits an atomic proposal with a supported `newDocumentContractIdx`.

Detailed runtime wire operations belong to the Agent and Operator protocol, not the Admin API Reference. Admin validation proves identity and compatibility only; it does not transfer private keys or user documents.
