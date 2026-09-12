# What is UniDocs?

UniDocs is a multi-format document platform for collaboration between people and Agents. It gives every document format a shared lifecycle for creation, versioning, comments, replies, storage, and automated processing without forcing every format into one editor or one schema.

## The four responsibilities

| Component | Responsibility |
| --- | --- |
| Platform | Owns documents, versions, comments, current pointers, submissions, configuration, and audit history. |
| View | Presents one document format in the browser through isolated interactive and thumbnail entrypoints. |
| Operator | Understands a document format and proposes complete new snapshots and replies. |
| UniCAS | Stores immutable snapshot, message, and attachment graphs without interpreting document semantics. |

The Platform is the data authority. A View does not call UniCAS or an Operator directly; it uses capabilities exposed by the Platform host. An Operator does not own a document session or exclusive write lease; it queries current Platform state and submits an atomic proposal.

## A document format is a composed experience

A format is not just a file extension or service URL. It combines:

- a stable `documentType`;
- one or more paired Document Contracts;
- a current Type Card bundle;
- a current View bundle;
- a current Operator;
- an enabled or disabled state.

Administrators assemble and evolve that composition. Users see only enabled formats whose selected resources are mutually compatible.

## Scope of this documentation

This section describes the UniDocs Admin Portal contract and the operational model behind it. The API Reference is generated from `@unidocs/protocol-admin-portal`. Public Tenant Portal and runtime Agent/View protocols are outside the current reference scope.
