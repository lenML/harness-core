import path from "node:path";
import fs from "node:fs";
import OpenAI from "openai";
import type {
  CoreContext,
  AgentPlugin,
  ISessionStore,
  ModelConfig,
  MessageEnvelope,
} from "../../types";
import { generateMessageId } from "../../utils/message-envelope";

class JsonlSessionStore implements ISessionStore {
  private baseDir: string;
  private cache = new Map<string, MessageEnvelope[]>();
  private ephemeralKeys = new Set<string>();
  private metadataCache = new Map<string, Record<string, any>>();

  constructor(workspace: string) {
    this.baseDir = path.join(workspace, ".sessions");
    if (!fs.existsSync(this.baseDir))
      fs.mkdirSync(this.baseDir, { recursive: true });

    this.loadMetadataFile();
  }

  private get metaFilePath() {
    return path.join(this.baseDir, "_metadata.json");
  }

  private loadMetadataFile() {
    if (fs.existsSync(this.metaFilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.metaFilePath, "utf-8"));
        for (const [k, v] of Object.entries(data)) {
          this.metadataCache.set(k, v as Record<string, any>);
        }
      } catch {}
    }
  }

  private saveMetadataFile() {
    const obj: Record<string, any> = {};
    for (const [k, v] of this.metadataCache.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(this.metaFilePath, JSON.stringify(obj, null, 2), "utf-8");
  }

  markEphemeral(key: string): void {
    this.ephemeralKeys.add(key);
  }
  unmarkEphemeral(key: string): void {
    this.ephemeralKeys.delete(key);
  }
  isEphemeral(key: string): boolean {
    return this.ephemeralKeys.has(key);
  }

  async load(key: string): Promise<MessageEnvelope[]> {
    if (this.cache.has(key)) return [...this.cache.get(key)!];
    if (this.isEphemeral(key)) return [];
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return [];
    try {
      const msgs: MessageEnvelope[] = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      );
      // Migration: ensure every message has an `id` and `createdAt`
      return msgs.map((m) => ({
        ...m,
        id: m.id || generateMessageId(),
        createdAt: m.createdAt || Date.now(),
      }));
    } catch {
      return [];
    }
  }

  async save(key: string, msgs: MessageEnvelope[]): Promise<void> {
    this.cache.set(key, msgs);
    if (!this.metadataCache.has(key)) {
      this.metadataCache.set(key, {
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    } else {
      this.metadataCache.get(key)!.lastActiveAt = Date.now();
    }
    this.saveMetadataFile();

    if (this.isEphemeral(key)) return;
    const filePath = this.getFilePath(key);
    fs.writeFileSync(filePath, JSON.stringify(msgs), "utf-8");
  }

  list(): Array<{
    key: string;
    messageCount: number;
    ephemeral: boolean;
    createdAt?: number;
    lastActiveAt?: number;
    metadata?: Record<string, any>;
  }> {
    const result: Array<any> = [];

    for (const [key, msgs] of this.cache.entries()) {
      const meta = this.metadataCache.get(key);
      result.push({
        key,
        messageCount: msgs.length,
        ephemeral: this.isEphemeral(key),
        createdAt: meta?.createdAt ?? null,
        lastActiveAt: meta?.lastActiveAt ?? null,
        metadata: meta?.custom ?? {},
      });
    }

    if (fs.existsSync(this.baseDir)) {
      const files = fs.readdirSync(this.baseDir);
      for (const file of files) {
        if (!file.endsWith(".json") || file === "_metadata.json") continue;
        const key = file.slice(0, -5).replace(/_/g, ":");
        if (this.cache.has(key)) continue;
        try {
          const content = fs.readFileSync(
            path.join(this.baseDir, file),
            "utf-8"
          );
          const msgs: MessageEnvelope[] = JSON.parse(content);
          const meta = this.metadataCache.get(key);
          result.push({
            key,
            messageCount: msgs.length,
            ephemeral: this.isEphemeral(key),
            createdAt: meta?.createdAt ?? msgs[0]?.createdAt ?? null,
            lastActiveAt:
              meta?.lastActiveAt ?? msgs[msgs.length - 1]?.createdAt ?? null,
            metadata: meta?.custom ?? {},
          });
        } catch {}
      }
    }

    return result;
  }

  clear(key: string): void {
    this.cache.delete(key);
    if (!this.isEphemeral(key)) {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  delete(key: string): void {
    this.clear(key);
    this.ephemeralKeys.delete(key);
    this.metadataCache.delete(key);
    this.saveMetadataFile();
  }

  destroyEphemeral(key: string): void {
    if (!this.isEphemeral(key)) return;
    this.cache.delete(key);
    this.metadataCache.delete(key);
    this.ephemeralKeys.delete(key);
  }

  estimateTokens(messages: MessageEnvelope[]): number {
    let total = 0;
    for (const msg of messages) {
      const c = msg.content;
      if (typeof c === "string") total += Math.floor(c.length / 4);
      else if (Array.isArray(c))
        for (const b of c)
          if (typeof b === "object" && "text" in b)
            total += Math.floor(b.text.length / 4);
    }
    return total;
  }

  async compact(
    messages: MessageEnvelope[],
    modelConfig?: ModelConfig
  ): Promise<MessageEnvelope[]> {
    if (messages.length <= 4) return messages;
    const half = Math.floor(messages.length / 2);
    const oldMsgs = messages.slice(0, half);
    const recentMsgs = messages.slice(half);

    const apiKey = modelConfig?.apiKey || process.env.OPENAI_API_KEY || "";
    const baseUrl = modelConfig?.baseUrl || process.env.OPENAI_BASE_URL;
    const modelId = modelConfig?.modelId || "gpt-4o";

    try {
      const openai = new OpenAI({ apiKey, baseURL: baseUrl });
      const resp = await openai.chat.completions.create({
        model: modelId,
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content:
              "Summarize concisely:\n\n" +
              oldMsgs.map((m) => `${m.role}: ${m.content || ""}`).join("\n"),
          },
        ],
      });
      const summary =
        resp.choices[0]?.message?.content || "[Summary unavailable]";
      return [
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
        ...recentMsgs,
      ];
    } catch {
      return recentMsgs;
    }
  }

  updateMetadata(key: string, metadata: Record<string, any>): void {
    if (!this.metadataCache.has(key)) {
      this.metadataCache.set(key, {
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
    }
    const meta = this.metadataCache.get(key)!;
    meta.custom = { ...(meta.custom || {}), ...metadata };
    this.saveMetadataFile();
  }

  hasSession(key: string): boolean {
    if (this.cache.has(key)) return true;
    if (this.metadataCache.has(key)) return true;
    const filePath = this.getFilePath(key);
    return fs.existsSync(filePath);
  }

  private getFilePath(key: string): string {
    return path.join(this.baseDir, `${key.replace(/[:/\\]/g, "_")}.json`);
  }
}

export class SessionPlugin implements AgentPlugin {
  name = "session";
  async install(ctx: CoreContext) {
    const store = new JsonlSessionStore(ctx.getWorkspace());
    ctx.provide("sessions", store);
    ctx.registerSessionStore(store);

    // llm:error handling is delegated to ContextGuardPlugin
  }
}
