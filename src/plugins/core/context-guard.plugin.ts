import OpenAI from "openai";
import type { CoreContext, AgentPlugin, MessageEnvelope } from "../../types";
import {
  envelopeToChatParam,
  generateMessageId,
} from "../../utils/message-envelope";

export class ContextGuardPlugin implements AgentPlugin {
  name = "context-guard";

  async install(ctx: CoreContext) {
    ctx.on("llm:error", async (ctx, { err, messages }) => {
      const errorMsg = String(err.message).toLowerCase();
      if (
        errorMsg.includes("context") ||
        errorMsg.includes("token") ||
        errorMsg.includes("length")
      ) {
        console.log(
          "[ContextGuard] Context overflow detected, compacting history..."
        );
        if (messages.length <= 4) return false;

        const half = Math.floor(messages.length / 2);
        const oldMsgs = messages.slice(0, half);
        const recentMsgs = messages.slice(half);

        try {
          const summaryPrompt =
            "Summarize the following conversation concisely, preserving key facts:\n\n" +
            oldMsgs
              .map((m: MessageEnvelope) => `${m.role}: ${m.content || ""}`)
              .join("\n");

          const config = ctx.getCurrentModelConfig();
          const client = new OpenAI({
            apiKey: config.apiKey || process.env.OPENAI_API_KEY,
            baseURL: config.baseUrl || process.env.OPENAI_BASE_URL,
          });
          const resp = await client.chat.completions.create({
            model: config.modelId,
            max_tokens: 1000,
            messages: [{ role: "user", content: summaryPrompt }],
          });
          const summary =
            resp.choices[0]?.message?.content || "[Summary unavailable]";

          messages.length = 0;
          messages.push(
            {
              id: generateMessageId(),
              role: "user",
              content: `[Previous conversation summary]\n${summary}`,
              createdAt: oldMsgs[0]?.createdAt || Date.now(),
            },
            {
              id: generateMessageId(),
              role: "assistant",
              content:
                "Understood, I have the context from our previous conversation.",
              createdAt: oldMsgs[oldMsgs.length - 1]?.createdAt || Date.now(),
            },
            ...recentMsgs
          );
          console.log(
            "[ContextGuard] Compaction successful. Retrying LLM call."
          );
          return true;
        } catch (summaryErr) {
          console.error(
            "[ContextGuard] Summary failed, dropping old messages.",
            summaryErr
          );
          messages.splice(0, half);
          return true;
        }
      }
      return false;
    });
  }
}
