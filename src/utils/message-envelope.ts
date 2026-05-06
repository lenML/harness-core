import crypto from "node:crypto";
import type { MessageEnvelope } from "../types";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export function generateMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Convert our internal MessageEnvelope to OpenAI-compatible ChatCompletionMessageParam.
 */
export function envelopeToChatParam(
  env: MessageEnvelope
): ChatCompletionMessageParam {
  switch (env.role) {
    case "system":
      return { role: "system", content: env.content || "" };
    case "user":
      return { role: "user", content: env.content || "" };
    case "assistant":
      return {
        role: "assistant",
        content: env.content,
        tool_calls: env.toolCalls,
      };
    case "tool":
      return {
        role: "tool",
        content: env.content || "",
        tool_call_id: env.toolCallId || "",
        name: env.name,
      };
    default:
      return { role: "user", content: env.content || "" };
  }
}

/**
 * Wrap a raw ChatCompletionMessageParam into our internal MessageEnvelope.
 */
export function chatParamToEnvelope(
  param: ChatCompletionMessageParam
): MessageEnvelope {
  const env: MessageEnvelope = {
    id: generateMessageId(),
    role: param.role,
    content:
      typeof param.content === "string" ? param.content : param.content || null,
    createdAt: Date.now(),
  };

  if (param.role === "assistant") {
    const p = param as Extract<
      ChatCompletionMessageParam,
      { role: "assistant" }
    >;
    if (p.tool_calls) {
      env.toolCalls = p.tool_calls;
    }
  } else if (param.role === "tool") {
    const p = param as Extract<ChatCompletionMessageParam, { role: "tool" }>;
    env.toolCallId = p.tool_call_id;
    env.name = p.name;
  }

  return env;
}

/**
 * Create a user envelope directly from text.
 */
export function createUserEnvelope(text: string): MessageEnvelope {
  return {
    id: generateMessageId(),
    role: "user",
    content: text,
    createdAt: Date.now(),
  };
}

/**
 * Create a tool result envelope.
 */
export function createToolResultEnvelope(
  toolCallId: string,
  content: string,
  name?: string
): MessageEnvelope {
  return {
    id: generateMessageId(),
    role: "tool",
    content,
    toolCallId,
    name,
    createdAt: Date.now(),
  };
}

/**
 * Create an assistant envelope from LLM response chunk.
 */
export function createAssistantEnvelope(
  content: string | null,
  toolCalls?: any[]
): MessageEnvelope {
  return {
    id: generateMessageId(),
    role: "assistant",
    content,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    createdAt: Date.now(),
  };
}
