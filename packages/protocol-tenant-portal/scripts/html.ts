import type { OpenAPI } from "@orpc/openapi";

const ScalarApiReferenceVersion = "1.68.0";

/** Locale codes in switch order; the first one renders on a first visit. */
export const ReferenceLocales = [
  { code: "en", label: "English" },
  { code: "zh", label: "简体中文" },
] as const;

export type ReferenceLocale = typeof ReferenceLocales[number]["code"];

export type LocalizedDocuments = Readonly<Record<ReferenceLocale, OpenAPI.Document>>;

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/**
 * One self-contained page holding every translation of the same document.
 *
 * Switching re-creates the Scalar reference against the other document rather
 * than reloading, and the choice is remembered per reader. A missing or
 * unreadable stored value simply falls back to the first locale, so the page
 * still renders in a private window or with site data blocked.
 */
export function renderTenantApiReferenceHtml(documents: LocalizedDocuments): string {
  const content = serializeForInlineScript(documents);
  const locales = serializeForInlineScript(ReferenceLocales);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>UniDocs Tenant API</title>
  <style>
    html, body, #app { height: 100%; margin: 0; }
    body { background: #fff; }
    #locale-switch {
      position: fixed;
      top: 12px;
      right: 16px;
      z-index: 100;
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 8px;
      background: rgba(127, 127, 127, 0.16);
      font: 500 13px/1 ui-sans-serif, system-ui, sans-serif;
    }
    #locale-switch button {
      padding: 6px 12px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
    }
    #locale-switch button[aria-pressed="true"] {
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f0f0f; }
      #locale-switch button[aria-pressed="true"] {
        background: #2f2f2f;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <nav id="locale-switch" aria-label="Documentation language"></nav>
  <div id="app"></div>
  <noscript>JavaScript is required to render the UniDocs Tenant API reference.</noscript>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${ScalarApiReferenceVersion}"></script>
  <script>
    (function () {
      var documents = ${content};
      var locales = ${locales};
      var storageKey = 'unidocs-tenant-api-locale';
      var current = null;

      function stored() {
        try {
          return window.localStorage.getItem(storageKey);
        } catch (error) {
          return null;
        }
      }

      function remember(code) {
        try {
          window.localStorage.setItem(storageKey, code);
        } catch (error) {
          // A reader with site data blocked still gets a working switch.
        }
      }

      function render(code) {
        if (code === current) return;
        current = code;
        document.documentElement.lang = code;
        document.getElementById('app').innerHTML = '';
        Scalar.createApiReference('#app', {
          content: documents[code],
          layout: 'modern',
          theme: 'default',
          // Scalar's modern layout collapses every tag but the first, and its
          // "Show more" button hard-codes open:true, so an expanded tag can
          // never be collapsed again. Opening every tag up front means that
          // one-way control is never rendered. Individual operations stay
          // collapsible either way. The option's performance warning is about
          // large documents; this one has 15 operations.
          defaultOpenAllTags: true,
          authentication: { preferredSecurityScheme: 'tenantSession' },
          pageTitle: 'UniDocs Tenant API'
        });
        Array.prototype.forEach.call(
          document.querySelectorAll('#locale-switch button'),
          function (button) {
            button.setAttribute('aria-pressed', String(button.dataset.locale === code));
          }
        );
      }

      var nav = document.getElementById('locale-switch');
      locales.forEach(function (locale) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = locale.label;
        button.dataset.locale = locale.code;
        button.addEventListener('click', function () {
          remember(locale.code);
          render(locale.code);
        });
        nav.appendChild(button);
      });

      var initial = stored();
      render(documents[initial] ? initial : locales[0].code);
    })();
  </script>
</body>
</html>
`;
}
