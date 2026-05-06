import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Parse YAML-like frontmatter from a markdown file.
 *
 * Supports:
 * - Simple key: value pairs
 * - Boolean values (true / false)
 * - Empty values (list indicator)
 * - YAML lists (- item)
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, any>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const rawMeta = match[1];
  const body = match[2];
  const metadata: Record<string, any> = {};

  let currentKey: string | null = null;

  for (const line of rawMeta.split(/\r?\n/)) {
    // List item: "  - value"
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(metadata[currentKey])) {
        metadata[currentKey] = [];
      }
      metadata[currentKey].push(listMatch[1].trim());
      continue;
    }

    // Key-value pair: "key: value"
    const kvMatch = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === "") {
        metadata[currentKey] = null; // could be a list indicator
      } else if (val === "true") {
        metadata[currentKey] = true;
      } else if (val === "false") {
        metadata[currentKey] = false;
      } else {
        metadata[currentKey] = val;
      }
    }
  }

  return { metadata, body };
}

/**
 * Render a skill body by executing all !`command` placeholders.
 *
 * Each !`<command>` is executed via shell, and its stdout replaces the placeholder.
 * This is a pre-processing step — the agent only sees the final rendered content.
 *
 * @param body  Raw skill body (after frontmatter stripping)
 * @param cwd   Working directory for command execution
 * @param timeout  Command timeout in ms (default 30000)
 */
export async function renderSkillBody(
  body: string,
  cwd?: string,
  timeout = 30000
): Promise<string> {
  const pattern = /!`([^`]+)`/g;
  const segments: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  let hasDynamic = false;

  while ((match = pattern.exec(body)) !== null) {
    hasDynamic = true;
    // Push text before the placeholder
    segments.push(body.slice(lastIndex, match.index));

    const command = match[1];
    try {
      const { stdout } = await execAsync(command, { timeout, cwd });
      segments.push((stdout || "").trim());
    } catch (err: any) {
      segments.push(`[Error executing: ${command}: ${err.message}]`);
    }

    lastIndex = match.index + match[0].length;
  }

  if (!hasDynamic) return body;

  // Push remaining text
  segments.push(body.slice(lastIndex));
  return segments.join("");
}
