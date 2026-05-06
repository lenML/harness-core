import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { ContentConverter } from "../../../types";

async function html2md(html: string, url: string) {
  // 1. Readability 提取正文
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse(); // 有 title, content, textContent, byline 等

  // 2. Turndown 转 Markdown
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndownService.turndown(article?.content);

  return {
    url,
    title: article?.title || "(No title)",
    markdown,
    text: article?.textContent || "(No content)",
    length: markdown.length,
  };
}

export const html2mdConverter: ContentConverter = async (
  content,
  contentType,
  url
) => {
  if (!contentType.includes("text/html")) {
    return content;
  }
  // 调用 html2md
  const { markdown } = await html2md(content, url);
  return `
ContentType: ${contentType}
${content.replace(/\n/g, "").slice(0, 64)}... (${markdown.length} chars)

---
Markdown formatted (compressed HTML):
${markdown}
`.trim();
};
