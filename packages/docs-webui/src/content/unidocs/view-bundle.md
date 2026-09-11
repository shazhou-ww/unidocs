# Build a View bundle

A View bundle contains the isolated browser experience for one document format. It has separate entrypoints for interactive use and deterministic thumbnail capture.

## Suggested bundle layout

```text
diagram-view.zip
├── manifest.json
├── interactive.html
├── thumbnail.html
├── modules/
└── assets/
```

## Manifest responsibilities

A version 1 manifest declares:

- `protocol: "unidocs-view-bundle/v1"`;
- the exact `documentType`;
- distinct `entrypoints.interactive` and `entrypoints.thumbnail` paths;
- one or more supported `DocumentContractIdx` values.

The interactive and thumbnail entrypoints must be different files. The interactive entrypoint contains document chrome and tools; the thumbnail entrypoint renders content without editor chrome at dimensions supplied by the host.

## Runtime boundary

The View runs in an isolated iframe. It does not directly call UniCAS, the Operator, or Platform HTTP APIs. A Platform Web Host grants capabilities over Host RPC for reading snapshots, storing blobs, updating viewport state, and working with comments.

The View must treat the supplied document contract index as part of the data contract. It should reject or explicitly degrade unsupported revisions rather than guessing.

## Upload and binding

The ZIP is immutable and content addressed. Uploading validates assets and creates a candidate but does not bind it. Select the candidate only after confirming its supported contract set is compatible with the intended Operator.
