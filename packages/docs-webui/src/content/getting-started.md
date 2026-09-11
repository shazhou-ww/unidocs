# Getting started

UniCAS is an independently deployable content-addressed storage service. It separates tenant data operations from stack administration so application traffic and operator sessions never share credentials.

## Choose an access plane

Use the **Tenant API** to store immutable nodes, protect prepared state with leases, read content, and commit business roots. Tenant requests use short-lived Stack-issued JWT capabilities.

Use the **Admin API** to create stacks, manage equal-authority members, configure capability issuers, and inspect audit data. Admin requests use the UniCAS OIDC/BFF session.

| Goal | Start here |
| --- | --- |
| Integrate an application with CAS | Tenant API and Leases and Root Refs |
| Provision or administer a stack | Admin API |
| Configure an external capability issuer | OAuth issuer activation |
| Diagnose storage or retry a failed workflow | Operations and recovery |

## The first integration

1. Ask a stack administrator for the immutable `stackId` and the expected CAS resource audience.
2. Configure an OAuth authorization server whose issuer can mint tenant capabilities for that audience.
3. Use a capability-scoped tenant client to lease and upload the immutable DAG.
4. Commit the complete Root Ref delta with one stable `requestId`.
5. Retry uncertain commits with the same request identity and payload.

## Security boundary

Never send an Admin session cookie to tenant routes, and never send a tenant bearer capability to `/admin`. UniCAS rejects credentials presented on the wrong plane.
