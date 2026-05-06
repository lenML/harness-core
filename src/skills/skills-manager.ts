import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SkillDef } from "../types";
import { parseFrontmatter, renderSkillBody } from "./skill-parser";

export class SkillsManager {
  skills: SkillDef[] = [];
  private skillMap = new Map<string, SkillDef>();
  private invocationMap = new Map<string, SkillDef>();

  constructor(private workspace: string, private projectWorkspace: string) {}

  async discover(): Promise<void> {
    // Global skills first, then project skills (project overrides global with same ID)
    await this.discoverFromDir(path.join(this.workspace, "skills"));
    await this.discoverFromDir(path.join(this.projectWorkspace, "skills"));
    this.rebuildIndexes();
  }

  /**
   * Find a skill whose invocation matches the first word of the input.
   * e.g. input="/example some-arg" → matches skill with invocation="/example"
   */
  findByInvocation(input: string): SkillDef | undefined {
    const firstWord = input.split(/\s+/)[0];
    return this.invocationMap.get(firstWord);
  }

  /**
   * Find a skill by name or id.
   * Accepts both "example" and "/example" style queries.
   */
  findByName(name: string): SkillDef | undefined {
    const normalized = name.replace(/^\//, "");
    return (
      this.skillMap.get(normalized) ||
      this.skills.find((s) => s.name === normalized || s.id === normalized)
    );
  }

  /**
   * Render a skill's body content by executing all dynamic !`command` placeholders.
   * This should be called at invocation time (not at discovery time) to ensure fresh data.
   */
  async renderSkill(skill: SkillDef, workdir?: string): Promise<string> {
    return renderSkillBody(skill.body, workdir || skill.sourceDir);
  }

  /**
   * Format a concise skills list for the system prompt.
   * This replaces the old approach of injecting full skill content.
   */
  formatPromptBlock(): string {
    if (!this.skills.length) return "";

    const lines = [
      "## Available Skills",
      "",
      "Use the `skill` tool to load a skill's full instructions. After loading, follow the skill's instructions precisely.",
      "Users can also invoke skills directly by typing the invocation (e.g. `/example`).",
      "",
    ];

    for (const skill of this.skills) {
      let line = `- **${skill.name}**`;
      const invocationParts = [skill.invocation];
      if (skill.argumentHint) invocationParts.push(skill.argumentHint);
      line += ` (\`${invocationParts.join(" ")}\`)`;
      line += `: ${skill.description.slice(0, 250)}`;
      if (skill.disableModelInvocation) {
        line += " — 🚫 manual invocation only";
      }
      lines.push(line);
    }

    return lines.join("\n");
  }

  // ── Private helpers ──────────────────────────────────────

  private async discoverFromDir(skillsDir: string): Promise<void> {
    if (!existsSync(skillsDir)) return;
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await this.loadSkill(path.join(skillsDir, entry.name), entry.name);
      }
    } catch {}
  }

  private async loadSkill(dirPath: string, dirName: string): Promise<void> {
    const skillMdPath = path.join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) return;

    try {
      const content = await fs.readFile(skillMdPath, "utf-8");
      const { metadata, body } = parseFrontmatter(content);

      const name = sanitizeName(metadata.name || dirName);
      const invocation = metadata.invocation || `/${name}`;
      const description = metadata.description || extractDescription(body);
      const argumentHint = metadata["argument-hint"] || undefined;
      const disableModelInvocation =
        metadata["disable-model-invocation"] === true;
      const userInvocable = metadata["user-invocable"] !== false;
      const allowedTools = parseAllowedTools(metadata["allowed-tools"]);

      const skill: SkillDef = {
        id: dirName,
        name,
        description,
        invocation,
        argumentHint,
        disableModelInvocation,
        userInvocable,
        allowedTools,
        body: body.trim(),
        sourceDir: dirPath,
      };

      // Project skills override global ones with same ID
      this.skillMap.set(dirName, skill);
    } catch {}
  }

  private rebuildIndexes(): void {
    this.skills = Array.from(this.skillMap.values());
    this.invocationMap.clear();
    for (const skill of this.skills) {
      this.invocationMap.set(skill.invocation, skill);
    }
  }
}

// ── Module-level utility functions ─────────────────────────

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

function extractDescription(body: string): string {
  const firstPara = body
    .split(/\n\n/)
    .find((p) => p.trim().length > 0 && !p.trim().startsWith("#"));
  return firstPara ? firstPara.trim().slice(0, 250) : "";
}

function parseAllowedTools(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}
