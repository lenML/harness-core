import type { CoreContext, AgentPlugin } from "../../types";
import { SkillsManager } from "../../skills/skills-manager";

export class SkillsPlugin implements AgentPlugin {
  name = "skills";

  async install(ctx: CoreContext) {
    const mgr = new SkillsManager(
      ctx.getWorkspace(),
      ctx.getProjectWorkspace()
    );
    await mgr.discover();
    ctx.provide("skills", mgr);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "skill",
          description:
            "Load and activate a skill by name to receive specialized instructions. " +
            "Skills provide focused capabilities for specific tasks. " +
            "After loading, follow the skill's instructions precisely.",
          parameters: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "The skill name or invocation (e.g., 'example' or '/example').",
              },
              arguments: {
                type: "string",
                description: "Optional arguments to pass to the skill.",
              },
            },
            required: ["name"],
          },
        },
      },
      handler: async (args) => {
        const { name, arguments: skillArgs } = args;
        const skillsMgr = ctx.tryConsume<SkillsManager>("skills");
        if (!skillsMgr) return "Error: Skills system not available.";

        const skill = skillsMgr.findByName(name);
        if (!skill) return `Error: Skill '${name}' not found.`;

        if (skill.disableModelInvocation) {
          return (
            `Skill '${skill.name}' requires manual user invocation ` +
            `(${skill.invocation}). Ask the user to invoke it directly.`
          );
        }

        try {
          const rendered = await skillsMgr.renderSkill(skill, ctx.getWorkdir());

          const parts: string[] = [`[Skill: ${skill.name}]`];
          if (skill.allowedTools.length > 0) {
            parts.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
          }
          if (rendered) parts.push(rendered);
          if (skillArgs) parts.push(`Arguments: ${skillArgs}`);

          return parts.join("\n\n");
        } catch (err: any) {
          return `Error loading skill '${skill.name}': ${err.message}`;
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      interruptible: true,
    });
  }
}
