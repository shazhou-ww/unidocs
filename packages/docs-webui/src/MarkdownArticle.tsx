import { marked } from "marked";
import { useEffect } from "react";
import type { Guide } from "./content.js";
import { products } from "./content.js";

marked.setOptions({ gfm: true });

export function MarkdownArticle({ guide }: { readonly guide: Guide }) {
  useEffect(() => {
    document.title = `${guide.title} | ${products[guide.product].name} Documentation`;
  }, [guide]);

  return (
    <article className="article-shell">
      <div className="article-kicker">{guide.section}</div>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: marked.parse(guide.markdown) as string }} />
    </article>
  );
}