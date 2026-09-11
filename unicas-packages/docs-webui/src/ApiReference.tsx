import { createApiReference } from "@scalar/api-reference";
import "@scalar/api-reference/style.css";
import { useEffect, useRef } from "react";
import type { ReferenceDefinition } from "./reference-config.js";
import { prepareReference } from "./reference-config.js";

export function ApiReference({ definition }: { readonly definition: ReferenceDefinition }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = `${definition.title} | UniCAS Documentation`;
    const tagOrder = new Map(definition.tagGroups.flatMap((group) => group.tags).map((name, index) => [name, index]));
    const operationOrder = new Map(definition.operationOrder.map((key, index) => [key, index]));
    const target = container.current;
    if (!target) return;

    let active = true;
    void prepareReference(definition).then((content) => {
      if (!active) return;
      createApiReference(target, {
        content,
        layout: "modern",
        theme: "default",
        hideTestRequestButton: true,
        showDeveloperTools: "never",
        orderSchemaPropertiesBy: "preserve",
        modelsSectionLabel: "Schemas",
        tagsSorter: (a, b) => (tagOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (tagOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER),
        operationsSorter: (a, b) => {
          const keyA = `${a.method.toUpperCase()} ${a.path}`;
          const keyB = `${b.method.toUpperCase()} ${b.path}`;
          return (operationOrder.get(keyA) ?? Number.MAX_SAFE_INTEGER) - (operationOrder.get(keyB) ?? Number.MAX_SAFE_INTEGER);
        },
      });
    });

    return () => {
      active = false;
      target.replaceChildren();
    };
  }, [definition]);

  return <div className="reference-shell" ref={container} />;
}