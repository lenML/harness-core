import OpenAI from "openai";
import type {
  CoreContext,
  AgentPlugin,
  StreamChunkCallback,
} from "../../types";
import type { ChatCompletion } from "openai/resources/chat/completions";

export class CoreAbilitiesPlugin implements AgentPlugin {
  name = "core-abilities";
  async install(ctx: CoreContext) {
    ctx.provide("workdir", ctx.getWorkdir());
    ctx.provide("workspace", ctx.getWorkspace());
    ctx.provide("projectWorkspace", ctx.getProjectWorkspace());

    ctx.registerModelProvider({
      async chat(system, messages, tools, signal, onChunk) {
        const config = ctx.getCurrentModelConfig();
        // Validate config and resolve baseUrl & apiKey with proper defaults
        let baseUrl = config.baseUrl || process.env.OPENAI_BASE_URL;
        if (baseUrl === "") baseUrl = undefined;
        // Ensure baseUrl is a valid HTTP/HTTPS URL if provided; otherwise use undefined (OpenAI default)
        if (baseUrl && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          console.warn(`[ModelProvider] Invalid baseUrl "${baseUrl}", falling back to default OpenAI endpoint.`);
          baseUrl = undefined;
        }
        const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error("Missing API key for model provider. Set OPENAI_API_KEY or configure providers.openai.apiKey.");
        }

        console.log(`[ModelProvider] Using model: ${config.modelId}, baseUrl: ${baseUrl || '(default OpenAI)'}, apiKey: ${apiKey ? '****' + apiKey.slice(-4) : 'missing'}`);

        const openai = new OpenAI({
          apiKey: apiKey,
          baseURL: baseUrl,
        });

        const allMessages: any[] = [
          { role: "system", content: system },
          ...messages,
        ];

        const hookHints = ctx.tryConsume<Map<string, string>>("hookHints");
        if (hookHints && hookHints.size > 0) {
          const hintLines: string[] = [];
          for (const [event, output] of hookHints) {
            hintLines.push(`[${event} hook output]: ${output}`);
          }
          allMessages[0].content +=
            "\n\n## Hook Outputs\n\n" + hintLines.join("\n");
          hookHints.clear();
        }

        // ── 流式请求 ──────────────────────────────
        // Attach a timeout if not already aborted
        let timeoutSignal = signal;
        const stream = await openai.chat.completions.create(
          {
            model: config.modelId,
            max_tokens: config.maxTokens ?? 1024 * 24,
            messages: allMessages,
            tools,
            stream: true,
            temperature: config.temperature ?? 1,
            top_p: config.topP ?? 1,
            presence_penalty: config.presencePenalty ?? 0,
            frequency_penalty: config.frequencyPenalty ?? 0,
          },
          { signal: timeoutSignal }
        );
        if (!signal) {
          const abortCtrl = new AbortController();
          const timeoutId = setTimeout(() => abortCtrl.abort(), 120000); // 2 minutes
          signal = abortCtrl.signal;
          timeoutSignal = abortCtrl.signal;
          // remove the timeout when done
          (async () => {
            try {
              await stream;
            } finally {
              clearTimeout(timeoutId);
            }
          })();
        }

        // ── 逐 chunk 累积并回调 ───────────────────
        let content = "";
        let finishReason: string | null = null;
        const toolCallsAcc = new Map<
          number,
          { id: string; functionName: string; arguments: string }
        >();

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // 文本增量
          if (delta?.content) {
            content += delta.content;
            onChunk?.({ content: delta.content });
          }

          // 工具调用增量
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, {
                  id: "",
                  functionName: "",
                  arguments: "",
                });
              }
              const acc = toolCallsAcc.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.functionName += tc.function.name;
              if (tc.function?.arguments)
                acc.arguments += tc.function.arguments;

              onChunk?.({
                toolCallDeltas: [
                  {
                    index: idx,
                    id: tc.id || undefined,
                    functionName: tc.function?.name || undefined,
                    argumentsDelta: tc.function?.arguments || undefined,
                  },
                ],
              });
            }
          }

          // 结束原因
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            onChunk?.({ finishReason: choice.finish_reason });
          }
        }

        // ── 组装最终 ChatCompletion ────────────────
        const message: any = {
          role: "assistant",
          content: content || null,
        };

        if (toolCallsAcc.size > 0) {
          message.tool_calls = Array.from(toolCallsAcc.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.functionName,
                arguments: tc.arguments,
              },
            }));
          message.refusal = null;
        }

        return {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion" as const,
          created: Math.floor(Date.now() / 1000),
          model: config.modelId,
          choices: [
            {
              index: 0,
              message,
              finish_reason: finishReason || "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        } as ChatCompletion;
      },
    });
  }
}
