import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  CoreContext,
  AgentPlugin,
  IPromptBuilder,
  AgentConfig,
  InboundMessage,
  MessageEnvelope,
} from "../../types";

export class PromptBuilderPlugin implements AgentPlugin {
  name = "prompt-builder";
  async install(ctx: CoreContext) {
    const workdir = ctx.getWorkdir();
    const workspace = ctx.getWorkspace();
    const projectWorkspace = ctx.getProjectWorkspace();

    ctx.registerPromptBuilder({
      async build(
        agent: AgentConfig,
        messages: MessageEnvelope[],
        msg: InboundMessage
      ): Promise<string> {
        const sections: string[] = [];
        const identity =
          (await loadFile(path.join(workspace, "IDENTITY.md"))) ||
          `You are ${agent.name}.`;
        sections.push(identity);
        const soul =
          (await loadFile(path.join(workspace, "SOUL.md"))) ||
          (agent.personality ? `Your personality: ${agent.personality}` : "");
        if (soul) sections.push(`## Personality\n\n${soul}`);

        try {
          const skillsMgr = ctx.tryConsume<any>("skills");
          if (skillsMgr) {
            const skillsBlock = skillsMgr.formatPromptBlock();
            if (skillsBlock) sections.push(skillsBlock);
          }
        } catch {}

        const toolsMd = await loadFile(path.join(workspace, "TOOLS.md"));
        if (toolsMd) sections.push(`## Tool Usage Guidelines\n\n${toolsMd}`);

        const globalMemMd = await loadFile(path.join(workspace, "MEMORY.md"));
        const projectMemMd = await loadFile(
          path.join(projectWorkspace, "MEMORY.md")
        );
        if (globalMemMd)
          sections.push(`## Global Evergreen Memory\n\n${globalMemMd}`);
        if (projectMemMd) sections.push(`## Project Memory\n\n${projectMemMd}`);
        if (globalMemMd || projectMemMd)
          sections.push(
            "## Memory Instructions\n\n- Use memory_write to save important facts.\n- Use scope='project' for project-specific facts, scope='global' for cross-project facts."
          );

        const agentsContent = await loadFile(
          path.join(projectWorkspace, "AGENTS.md")
        );
        if (agentsContent) sections.push(`## AGENTS\n\n${agentsContent}`);

        for (const name of ["HEARTBEAT.md", "BOOTSTRAP.md", "USER.md"]) {
          const content = await loadFile(path.join(workspace, name));
          if (content)
            sections.push(`## ${name.replace(".md", "")}\n\n${content}`);
        }

        const currentModelKey = ctx.getCurrentModelKey();
        const currentModelConfig = ctx.getCurrentModelConfig();
        const now =
          new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
        sections.push(
          `## Runtime Context\n\n` +
            `- Agent ID: ${agent.id}\n- Model: [${currentModelKey}] ${currentModelConfig.modelId}\n` +
            `- Channel: ${msg.channel}\n- Current time: ${now}\n` +
            `- Workdir (default cwd): ${workdir}\n- Workspace: ${workspace}\n- Project Workspace: ${projectWorkspace}`
        );

        const hints: Record<string, string> = {
          cli: "You are responding via a terminal REPL. Markdown is supported.",
          telegram: "You are responding via Telegram. Keep messages concise.",
        };
        sections.push(
          `## Channel\n\n${
            hints[msg.channel] || `You are responding via ${msg.channel}.`
          }`
        );

        return sections.join("\n\n");
      },
    });

    async function loadFile(filePath: string): Promise<string> {
      if (!existsSync(filePath)) return "";
      try {
        return (await fs.readFile(filePath, "utf-8")).trim();
      } catch {
        return "";
      }
    }
  }
}
