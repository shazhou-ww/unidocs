import { marked } from "marked";
import DOMPurify from "dompurify";

export function markdownPreviewHtml(content: string): string {
  const fragment = DOMPurify.sanitize(marked.parse(content, { async: false }), {
    USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "iframe", "form", "input", "button", "video", "audio", "source", "picture"],
    FORBID_ATTR: ["src", "srcset", "style", "background", "poster"],
  });
  fragment.querySelectorAll("img").forEach(image => {
    const placeholder = document.createElement("span");
    placeholder.className = "cloud-image-placeholder";
    placeholder.textContent = `图片：${image.alt || "未命名"}（外链图片未加载）`;
    image.replaceWith(placeholder);
  });
  fragment.querySelectorAll("a").forEach(anchor => {
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    else anchor.removeAttribute("href");
  });
  const container = document.createElement("div"); container.append(fragment);
  return container.innerHTML;
}