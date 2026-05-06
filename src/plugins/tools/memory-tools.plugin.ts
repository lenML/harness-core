import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { CoreContext, AgentPlugin, ToolDef } from "../../types";

export class MemoryToolsPlugin implements AgentPlugin {
  name = "memory-tools";
  async install(ctx: CoreContext) {
    const workspace = ctx.getWorkspace();
    const projectWorkspace = ctx.getProjectWorkspace();
    const globalMemoryDir = path.join(workspace, "memory", "daily");
    const projectMemoryDir = path.join(projectWorkspace, "memory", "daily");

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "memory_write",
          description: "Save fact to long-term memory.",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string" },
              category: { type: "string" },
              scope: {
                type: "string",
                enum: ["project", "global"],
                description:
                  "Where to store: 'project' (default, project-specific) or 'global' (shared across projects).",
              },
            },
            required: ["content"],
          },
        },
      },
      handler: async (args) => {
        const scope = args.scope || "project";
        const memoryDir =
          scope === "global" ? globalMemoryDir : projectMemoryDir;
        await fs.mkdir(memoryDir, { recursive: true });
        const today = new Date().toISOString().slice(0, 10);
        const filePath = path.join(memoryDir, `${today}.jsonl`);
        try {
          await fs.appendFile(
            filePath,
            JSON.stringify({
              ts: new Date().toISOString(),
              category: args.category || "general",
              content: args.content,
            }) + "\n",
            "utf-8"
          );
          return `Memory saved (${scope}).`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
      isReadOnly: false,
      isConcurrencySafe: false,
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "memory_search",
          description: "Search stored memories (both global and project).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              scope: {
                type: "string",
                enum: ["project", "global", "all"],
                description:
                  "Which scope to search: 'all' (default), 'project', or 'global'.",
              },
            },
            required: ["query"],
          },
        },
      },
      handler: async (args) => {
        const queryLower = args.query.toLowerCase();
        const scope = args.scope || "all";
        const matches: string[] = [];

        // Search global MEMORY.md
        if (scope === "all" || scope === "global") {
          const globalMemMdPath = path.join(workspace, "MEMORY.md");
          if (existsSync(globalMemMdPath)) {
            const text = (await fs.readFile(globalMemMdPath, "utf-8")).trim();
            for (const para of text.split("\n\n")) {
              if (para.toLowerCase().includes(queryLower)) matches.push(para);
            }
          }
        }

        // Search project MEMORY.md
        if (scope === "all" || scope === "project") {
          const projectMemMdPath = path.join(projectWorkspace, "MEMORY.md");
          if (existsSync(projectMemMdPath)) {
            const text = (await fs.readFile(projectMemMdPath, "utf-8")).trim();
            for (const para of text.split("\n\n")) {
              if (para.toLowerCase().includes(queryLower)) matches.push(para);
            }
          }
        }

        // Search global daily memory
        if (scope === "all" || scope === "global") {
          await searchDailyMemory(globalMemoryDir, queryLower, matches);
        }

        // Search project daily memory
        if (scope === "all" || scope === "project") {
          await searchDailyMemory(projectMemoryDir, queryLower, matches);
        }

        return matches.length
          ? matches.slice(0, 10).join("\n")
          : `No memories matching '${args.query}'.`;
      },
      isReadOnly: true,
      isConcurrencySafe: true,
    } as ToolDef);

    async function searchDailyMemory(
      dir: string,
      queryLower: string,
      matches: string[]
    ) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files
          .filter((f) => f.endsWith(".jsonl"))
          .slice(-5)) {
          const content = await fs.readFile(path.join(dir, file), "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (
                entry.content &&
                entry.content.toLowerCase().includes(queryLower)
              )
                matches.push(entry.content);
            } catch {}
          }
        }
      } catch {}
    }
  }
}
