# Build a Type Card bundle

A Type Card bundle defines how a document format appears before a document is opened. It is the user-facing source for the format name, description, icon, sample thumbnail, and accessible thumbnail text.

## Suggested bundle layout

```text
diagram-type-card.zip
├── manifest.json
├── icon.svg
└── sample.webp
```

The exact paths are declared by the manifest and must be normalized bundle-relative paths.

## Manifest responsibilities

A version 1 manifest declares:

- `protocol: "unidocs-type-card/v1"`;
- the exact `documentType`;
- localized card content keyed by locale;
- one SVG icon or a complete PNG size set;
- a sample thumbnail asset.

`locales` must contain `en` as the final fallback. Each locale supplies `name`, `description`, and `sampleThumbnailAlt`.

For raster icons, provide all required sizes: 16, 32, 64, 128, and 256 pixels. Otherwise provide one scalable SVG.

## Immutable content, mutable metadata

The validated ZIP is immutable and content addressed. Its canonical `bundleUrl`, manifest, and bundle identity never change. Administrator-facing `name` and `description` live on the Platform record and can be updated under `If-Match` without creating another bundle.

## Upload is not selection

Uploading the bundle creates a candidate resource. It does not change the document type. After inspection, select its `typeCardBundleId` in the conditional document type update.
