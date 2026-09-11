# Investigate audit events

The Admin audit feed is the canonical timeline for configuration changes and validation outcomes. It is paginated and can be narrowed by actor, action, resource type, document type, or occurrence window.

## Start with the affected format

Filter by `documentType` and a bounded `occurredFrom`/`occurredTo` interval. This usually reveals contract appends, candidate creation, metadata updates, binding changes, enablement changes, and Operator validation failures in one timeline.

## Follow resource identity

Use `resourceType` and the event resource identity to distinguish an immutable candidate from the document type binding that selected it. Correlate the event with the resource's canonical GET representation, not a collection summary.

## Identify the actor and intent

Filter by `actorId` when investigating an administrator or automation. Review the recorded reason and request correlation alongside the action. Idempotent replay should represent one committed mutation rather than several configuration changes.

## Investigate a failed rollout

1. Find the document type update that selected the new resources.
2. Read the referenced Type Card, View, and Operator.
3. Compare View and Operator supported contract revisions.
4. Locate their creation or validation events.
5. Disable the format if user impact continues.
6. Stage corrected candidates and apply an explicit repair update.

Audit data explains control-plane changes. Runtime service logs and request traces remain the source for execution failures after a valid binding is selected.
