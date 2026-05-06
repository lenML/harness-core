import crypto from "node:crypto";
import type {
  CoreContext,
  AgentPlugin,
  ToolDef,
  InboundMessage,
} from "../../types";

const MAX_AGENT_DEPTH = 3;

export class AgentToolPlugin implements AgentPlugin {
  name = "agent-tool";

  async install(ctx: CoreContext) {
    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "agent",
          description:
            "Spawn a sub-agent with its own independent context window to handle a task. " +
            "The sub-agent has access to the same tools you do. " +
            "By default the sub-agent is ephemeral: it runs to completion, returns its result, and is then destroyed. " +
            "Set longLived=true to keep the agent available for follow-up interactions (returns its ID).",
          parameters: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description:
                  "A clear, self-contained description of the task for the sub-agent to complete.",
              },
              longLived: {
                type: "boolean",
                description:
                  "If true, the sub-agent persists after completion and can receive further messages. Default: false.",
              },
              agentName: {
                type: "string",
                description:
                  "Optional display name for the sub-agent. Default: 'Sub-Agent'.",
              },
              model: {
                type: "string",
                description:
                  "Optional model key from config to use for this sub-agent (e.g. 'fast'). Defaults to the active model.",
              },
            },
            required: ["task"],
          },
        },
      },
      handler: async (args) => {
        const { task, longLived = false, agentName, model } = args;

        // Depth guard
        const currentDepth = ctx.tryConsume<number>("agentDepth") || 0;
        if (currentDepth >= MAX_AGENT_DEPTH) {
          return `Error: Maximum agent nesting depth (${MAX_AGENT_DEPTH}) reached. Cannot spawn more sub-agents.`;
        }

        const subId = `sub_${crypto
          .randomUUID()
          .replace(/-/g, "")
          .slice(0, 10)}`;

        ctx.registerAgent({
          id: subId,
          name: agentName || "Sub-Agent",
          personality:
            "You are a focused sub-agent created to complete a specific assignment. " +
            "Work efficiently, use available tools as needed, and provide a clear summary when done.",
        });

        const msg: InboundMessage = {
          text: task,
          senderId: "agent-spawner",
          channel: "background",
          accountId: "internal",
          peerId: `agent:${subId}`,
          isGroup: false,
          media: [],
          raw: {},
        };

        // Temporarily override active model if requested
        let prevModel: string | undefined;
        if (model) {
          try {
            prevModel = ctx.getCurrentModelKey();
            ctx.switchModel(model);
          } catch {
            // Invalid model key, keep current
          }
        }

        // Increase depth
        ctx.provide("agentDepth", currentDepth + 1);

        try {
          const response = await ctx.handleMessage(msg);

          if (longLived) {
            return (
              `[Sub-Agent Created] ID: ${subId}\n` +
              `Name: ${agentName || "Sub-Agent"}\n\n` +
              `Result:\n${response}\n\n` +
              `This agent is persistent. Reference it with peerId "agent:${subId}".`
            );
          }

          // Ephemeral: clean up session and agent
          try {
            const { sessionKey } = ctx.resolveRouting(msg);
            ctx.getSessionStore().clear(sessionKey);
          } catch {}
          ctx.unregisterAgent(subId);

          return `[Sub-Agent Result] (${subId})\n\n${response}`;
        } catch (err: any) {
          // Clean up on error
          try {
            const { sessionKey } = ctx.resolveRouting(msg);
            ctx.getSessionStore().clear(sessionKey);
          } catch {}
          ctx.unregisterAgent(subId);
          return `Error: Sub-agent failed: ${err.message}`;
        } finally {
          // Restore depth
          ctx.provide("agentDepth", currentDepth);
          // Restore model if we switched
          if (prevModel) {
            try {
              ctx.switchModel(prevModel);
            } catch {}
          }
        }
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      /**
       * Agent tool is non-interruptible. Once spawned, it should finish its current
       * processing cycle to avoid leaving orphan tasks or corrupting its sub-session state
       * unexpectedly. Interrupts will be processed after the current sub-agent turn completes.
       */
      interruptible: false,
    } as ToolDef);
  }
}
