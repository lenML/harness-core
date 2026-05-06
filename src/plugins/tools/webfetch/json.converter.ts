import { encode } from "@toon-format/toon";
import { ContentConverter } from "../../../types";

function getObjectHint(data: any) {
  if (typeof data !== "object") return typeof data;
  if (data === null) return "null";
  // 使用 "..." 代替原值，用来表达原数据是JSON格式
  let raw_hint = JSON.stringify(
    Object.fromEntries(Object.entries(data).map(([k]) => [k, "..."]))
  );
  if (raw_hint.length > 64) {
    raw_hint = raw_hint.slice(0, 64) + "...";
  }
  return raw_hint;
}

/**
 * 使用 toon 对 JSON 数据进行压缩
 *
 * 并且会注明原本是 JSON 数据，现在是被压缩之后的
 */
export const jsonConverter: ContentConverter = async (
  content,
  contentType,
  url
) => {
  if (!contentType.includes("application/json")) {
    return content;
  }
  const data = JSON.parse(content);
  if (data === null || data === undefined) {
    return content;
  } else if (typeof data !== "object") {
    return content;
  }
  // 用来表示原始结构
  let raw_hint = "";
  if (Array.isArray(data)) {
    raw_hint = `Array<${getObjectHint(data[0])}>`;
  } else {
    raw_hint = getObjectHint(data);
  }
  const compressed = encode(data);
  return `
ContentType: application/json
${raw_hint}

---
TOON Formatted (compressed JSON)：
${compressed}
`.trim();
};
