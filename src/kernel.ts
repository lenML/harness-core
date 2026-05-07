import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CoreContext,
  AgentPlugin,
  InboundMessage,
  IRouter,
  ISessionStore,
  IPromptBuilder,
  IModelProvider,
  ToolDef,
  HookType,
  HookHandler,
  AgentConfig,
  ModelConfig,
  ToolCallInfo,
  AppConfig,
  AskUserHandler,
  AskUserContext,
  StreamChunk,
  StreamChunkCallback,
  MessageEnvelope,
  SystemStats,
  ToolStatItem,
} from "./types";
import type {
  ChatCompletion,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { ToolExecutor } from "./tools/tool-executor";
import { loadConfig, saveConfig, resolveModelConfig } from "./config";
import {
  generateMessageId,
  envelopeToChatParam,
  createUserEnvelope,
  createToolResultEnvelope,
  createAssistantEnvelope,
} from "./utils/message-envelope";

const messageContext = new AsyncLocalStorage<InboundMessage>();

const STREAM_INTERRUPT_MARKER = "\n\n[此处因为用户发起中断而截断]";

interface SessionProcessingState {
  controller: AbortController;
}

interface InternalToolStat {
  callCount: number;
  errorCount: number;
  totalDuration: number;
  lastCalledAt: number;
  _startTime?: number;
}

// Simple deep path setter
function setPath(obj: any, path: string, value: any) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Parse a session key of the format "agent:<agentId>:<channel>:<peerId>".
 *
 * The peerId may contain colons (e.g. "cron:job1"), so we only split on
 * the first three colons and treat everything after as the peerId.
 *
 * Returns { agentId, channel, peerId }. Falls back to sensible defaults
 * if the format doesn't match.
 */
export function parseSessionKey(sessionKey: string): {
  agentId: string;
  channel: string;
  peerId: string;
} {
  const prefix = "agent:";
  if (!sessionKey.startsWith(prefix)) {
    return { agentId: "main", channel: "gateway", peerId: sessionKey };
  }
  const withoutPrefix = sessionKey.slice(prefix.length);
  const firstColon = withoutPrefix.indexOf(":");
  if (firstColon < 0) {
    return {
      agentId: withoutPrefix,
      channel: "gateway",
      peerId: withoutPrefix,
    };
  }
  const agentId = withoutPrefix.slice(0, firstColon);
  const rest = withoutPrefix.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (secondColon < 0) {
    return { agentId, channel: rest, peerId: rest };
  }
  const channel = rest.slice(0, secondColon);
  const peerId = rest.slice(secondColon + 1);
  return { agentId, channel, peerId };
}

export class AgentKernel implements CoreContext {
  private plugins: AgentPlugin[] = [];

  private router!: IRouter;
  private sessionStore!: ISessionStore;
  private promptBuilder!: IPromptBuilder;
  private modelProvider!: IModelProvider;

  private agents = new Map<string, AgentConfig>();
  private tools = new Map<string, ToolDef>();
  private services = new Map<string, any>();

  private hooks = new Map<string, HookHandler[]>();
  private askUserHandlers = new Map<string, AskUserHandler>();

  private backgroundQueue: InboundMessage[] = [];
  private isRunning = false;
  private startedAt = Date.now();

  private workdir: string;
  private workspace: string;
  private projectWorkspace: string;
  private config: AppConfig;
  private configPath: string;

  private toolConcurrency: number;
  private maxLoopIterations: number;

  private ephemeralChannels = new Set<string>();

  private processingSessions = new Map<string, SessionProcessingState>();
  private interruptQueues = new Map<string, string[]>();

  public authToken: string = "";

  // Observability
  private totalMessagesReceived = 0;
  private totalToolCalls = 0;
  private toolStatsMap = new Map<string, InternalToolStat>();

  constructor() {
    this.workdir = process.cwd();
    this.workspace = path.resolve(this.workdir, "./workspace");
    this.projectWorkspace = path.resolve(this.workdir, "./.harness");

    if (!fs.existsSync(this.workspace)) {
      fs.mkdirSync(this.workspace, { recursive: true });
    }
    if (!fs.existsSync(this.projectWorkspace)) {
      fs.mkdirSync(this.projectWorkspace, { recursive: true });
    }

    this.configPath = path.join(this.workspace, "config.json");
    this.config = loadConfig(this.configPath);

    this.toolConcurrency = this.config.defaults.toolConcurrency || 10;
    this.maxLoopIterations = this.config.defaults.maxLoopIterations || 15;

    for (const [channel, cfg] of Object.entries(this.config.channels)) {
      if (cfg.ephemeral) this.ephemeralChannels.add(channel);
    }

    for (const [id, entry] of Object.entries(this.config.agents)) {
      this.agents.set(id, {
        id,
        name: entry.name,
        personality: entry.personality,
      });
    }

    if (this.agents.size === 0) {
      this.agents.set("main", {
        id: "main",
        name: "Assistant",
        personality: "helpful, curious, and concise",
      });
    }

    this.installInternalHooks();
  }

  public setAuth(authToken: string = crypto.randomUUID()) {
    this.authToken = authToken;
    console.log(`[Kernel] Generated Auth Token: ${this.authToken}`);
  }

  private installInternalHooks() {
    this.on("tool:before", async (ctx, payload) => {
      const name = payload?.tool?.function?.name;
      if (name) {
        this.totalToolCalls++;
        if (!this.toolStatsMap.has(name))
          this.toolStatsMap.set(name, {
            callCount: 0,
            errorCount: 0,
            totalDuration: 0,
            lastCalledAt: 0,
          });
        const stat = this.toolStatsMap.get(name)!;
        stat.callCount++;
        stat.lastCalledAt = Date.now();
        stat._startTime = Date.now();
      }
      return false;
    });

    this.on("tool:after", async (ctx, payload) => {
      const name = payload?.tool?.function?.name;
      if (name && this.toolStatsMap.has(name)) {
        const stat = this.toolStatsMap.get(name)!;
        if (stat._startTime) {
          stat.totalDuration += Date.now() - stat._startTime;
          delete stat._startTime;
        }
        if (
          typeof payload?.result === "string" &&
          payload.result.startsWith("Error")
        )
          stat.errorCount++;
      }
      return false;
    });
  }

  setEphemeralChannel(channel: string, ephemeral = true): void {
    if (ephemeral) this.ephemeralChannels.add(channel);
    else this.ephemeralChannels.delete(channel);
  }

  getEphemeralChannels(): Set<string> {
    return new Set(this.ephemeralChannels);
  }

  parseThinkingTagContent(text: string) {
    const think_pattern = /iterrition([\s\S]*?)<\/think>/;
    if (text.match(think_pattern)) {
      const [think_block = "", think_content] = think_pattern.exec(text) || [];
      const response = text.replace(think_block, "");
      return { response: response.trim(), thinking: think_content.trim() };
    }
    return { response: text.trim(), thinking: "" };
  }

  parseThinking(message: ChatCompletionMessage) {
    if (
      "reasoning_content" in message &&
      typeof message.reasoning_content === "string"
    ) {
      return {
        response: message.content || "",
        thinking: message.reasoning_content || "",
      };
    }
    const text = message.content || "";
    return this.parseThinkingTagContent(text);
  }

  logThinking(content: string) {
    console.log(`  💭 ${content.replace(/[\n\t]/g, " ").slice(0, 24)}...`);
  }

  logMessageThinking(message: ChatCompletionMessage) {
    const { thinking } = this.parseThinking(message);
    if (thinking) this.logThinking(thinking);
  }

  postProcessMessage(text: string) {
    const { response } = this.parseThinkingTagContent(text);
    return response;
  }

  enqueueUserMessage(msg: InboundMessage, targetSessionKey?: string): void {
    const sessionKey = targetSessionKey ?? this.router.resolve(msg).sessionKey;
    // Ensure session exists before enqueueing (e.g., when session is busy and hasn't been created yet)
    this.ensureSession(sessionKey).catch((err) =>
      console.error(`[Kernel] Failed to ensure session ${sessionKey}:`, err)
    );
    if (!this.interruptQueues.has(sessionKey)) {
      this.interruptQueues.set(sessionKey, []);
    }
    this.interruptQueues.get(sessionKey)!.push(msg.text);

    const current = this.processingSessions.get(sessionKey);
    if (current && !current.controller.signal.aborted) {
      current.controller.abort();
    } else if (!current) {
      messageContext.run(msg, () => this.processSessionQueue(msg, sessionKey));
    }
  }

  async handleMessage(
    msg: InboundMessage,
    targetSessionKey?: string
  ): Promise<string> {
    this.totalMessagesReceived++;
    const sessionKey = targetSessionKey ?? this.router.resolve(msg).sessionKey;
    if (this.processingSessions.has(sessionKey)) {
      this.enqueueUserMessage(msg, sessionKey);
      return "";
    }
    return messageContext.run(msg, () =>
      this.processSessionQueue(msg, sessionKey)
    );
  }

  createSession(options: {
    channel?: string;
    peerId?: string;
    agentId?: string;
    ephemeral?: boolean;
  }): { sessionKey: string; agentId: string } {
    const channel = options.channel || "gateway";
    const peerId =
      options.peerId ||
      `peer:${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

    let agentId = options.agentId;
    if (!agentId) {
      const fakeMsg: InboundMessage = {
        text: "",
        senderId: "",
        channel,
        accountId: "",
        peerId,
        isGroup: false,
        media: [],
        raw: {},
      };
      const resolved = this.router.resolve(fakeMsg);
      agentId = resolved.agentId;
    }

    const sessionKey = `agent:${agentId}:${channel}:${peerId}`;

    // Ensure session is recorded in store even before any message arrives
    this.ensureSession(sessionKey, options.ephemeral || false).catch((err) => {
      console.error(
        `[Kernel] Failed to ensure newly created session ${sessionKey}:`,
        err
      );
    });

    if (options.ephemeral) {
      this.sessionStore.markEphemeral(sessionKey);
    }

    return { sessionKey, agentId };
  }

  deleteSession(sessionKey: string): void {
    this.sessionStore.delete(sessionKey);
  }

  async regenerateSession(sessionKey: string): Promise<string> {
    if (this.processingSessions.has(sessionKey)) {
      throw new Error("Session is currently processing, cannot regenerate.");
    }

    const messages = await this.sessionStore.load(sessionKey);
    if (messages.length === 0) throw new Error("Session is empty.");

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) throw new Error("No user message found.");

    const truncated = messages.slice(0, lastUserIdx + 1);
    await this.sessionStore.save(sessionKey, truncated);

    const {
      agentId: skAgentId,
      channel: skChannel,
      peerId: skPeerId,
    } = parseSessionKey(sessionKey);

    const fakeMsg: InboundMessage = {
      text: truncated[lastUserIdx].content || "",
      senderId: "regenerate",
      channel: skChannel,
      accountId: "",
      peerId: `agent:${skAgentId}:${skPeerId}`,
      isGroup: false,
      media: [],
      raw: {},
    };

    // Pass explicit sessionKey so we reuse the same session regardless of routing
    return messageContext.run(fakeMsg, () =>
      this.processSessionQueue(fakeMsg, sessionKey, true)
    );
  }

  // ── P1 & P2 Methods ──────────────────────────────────

  async forkSession(sessionKey: string, messageId: string): Promise<string> {
    if (this.processingSessions.has(sessionKey)) {
      throw new Error("Session is currently processing, cannot fork.");
    }

    const messages = await this.sessionStore.load(sessionKey);
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1) throw new Error("Message not found.");

    const forkedMessages = messages.slice(0, index + 1);

    const {
      agentId: skAgentId,
      channel: skChannel,
      peerId: skPeerId,
    } = parseSessionKey(sessionKey);

    const { sessionKey: newSessionKey } = this.createSession({
      channel: skChannel,
      peerId: `fork_${crypto
        .randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)}_from_${skPeerId}`,
      agentId: skAgentId,
    });

    await this.sessionStore.save(newSessionKey, forkedMessages);
    return newSessionKey;
  }

  async editSessionMessage(
    sessionKey: string,
    messageId: string,
    newText: string
  ): Promise<string> {
    if (this.processingSessions.has(sessionKey)) {
      throw new Error("Session is currently processing, cannot edit.");
    }

    const messages = await this.sessionStore.load(sessionKey);
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1) throw new Error("Message not found.");

    const msg = messages[index];
    if (msg.role !== "user") {
      throw new Error("Only user messages can be edited.");
    }

    msg.content = newText;
    const truncated = messages.slice(0, index + 1);
    await this.sessionStore.save(sessionKey, truncated);

    const {
      agentId: skAgentId,
      channel: skChannel,
      peerId: skPeerId,
    } = parseSessionKey(sessionKey);

    const fakeMsg: InboundMessage = {
      text: newText,
      senderId: "edit",
      channel: skChannel,
      accountId: "",
      peerId: `agent:${skAgentId}:${skPeerId}`,
      isGroup: false,
      media: [],
      raw: {},
    };

    return messageContext.run(fakeMsg, () =>
      this.processSessionQueue(fakeMsg, sessionKey, true)
    );
  }

  getStats(): SystemStats {
    const mem = process.memoryUsage();
    return {
      uptime: Date.now() - this.startedAt,
      totalSessions: this.sessionStore.list().length,
      activeProcessing: this.processingSessions.size,
      totalMessagesReceived: this.totalMessagesReceived,
      totalToolCalls: this.totalToolCalls,
      backgroundQueueSize: this.backgroundQueue.length,
      memoryUsage: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
    };
  }

  getToolStats(): ToolStatItem[] {
    return Array.from(this.toolStatsMap.entries()).map(([name, stat]) => ({
      name,
      callCount: stat.callCount,
      errorCount: stat.errorCount,
      avgDurationMs:
        stat.callCount > 0
          ? Math.round(stat.totalDuration / stat.callCount)
          : 0,
      lastCalledAt: stat.lastCalledAt,
    }));
  }

  updateConfig(dotPath: string, value: any): void {
    setPath(this.config, dotPath, value);
    saveConfig(this.configPath, this.config);
  }

  updateSessionMetadata(
    sessionKey: string,
    metadata: Record<string, any>
  ): void {
    this.sessionStore.updateMetadata(sessionKey, metadata);
  }

  // ── Core Processing Loop ─────────────────────────────

  private async ensureSession(
    sessionKey: string,
    ephemeral = false
  ): Promise<void> {
    if (this.sessionStore.hasSession(sessionKey)) return;

    await this.sessionStore.save(sessionKey, []);
    if (ephemeral) {
      this.sessionStore.markEphemeral(sessionKey);
    } else {
      // Check channel ephemeral flag from config for this session
      const { channel } = parseSessionKey(sessionKey);
      if (this.ephemeralChannels.has(channel)) {
        this.sessionStore.markEphemeral(sessionKey);
      }
    }
  }

  private async processSessionQueue(
    initialMsg: InboundMessage,
    sessionKey: string,
    skipAppendUserMessage = false
  ): Promise<string> {
    await this.ensureSession(sessionKey);
    const controller = new AbortController();
    const processingId = `core_${Date.now()}_${(
      this.processingSessions.size + 1
    ).toString(36)}`;
    this.processingSessions.set(sessionKey, { controller });

    // Emit processing started lifecycle hook
    await this.emit("session.processing_started", this, {
      sessionKey,
      processingId,
    });

    // Derive agentId from the sessionKey directly instead of re-routing.
    // This ensures stability: the sessionKey is the source of truth for
    // which agent handles this session, regardless of routing changes.
    const { agentId } = parseSessionKey(sessionKey);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Validate that the session still exists (not deleted) and if ephemeral, ensure it hasn't been destroyed.
    // This prevents processing messages for sessions that were cleaned up.
    const existing = await this.sessionStore.load(sessionKey);
    if (!existing) {
      throw new Error(`Session ${sessionKey} does not exist or was deleted.`);
    }

    const { channel: skChannel } = parseSessionKey(sessionKey);
    if (this.ephemeralChannels.has(skChannel)) {
      this.sessionStore.markEphemeral(sessionKey);
    }

    let messages = await this.sessionStore.load(sessionKey);

    if (!skipAppendUserMessage) {
      const initialText = initialMsg.text;
      const queue = this.interruptQueues.get(sessionKey) || [];
      if (!queue.includes(initialText)) {
        messages.push(createUserEnvelope(initialText));
      }
    }

    let finalResponse = "";
    const tools = this.getTools();

    try {
      let i = 0;
      for (; i < this.maxLoopIterations; i++) {
        const interrupts = this.interruptQueues.get(sessionKey) || [];
        this.interruptQueues.set(sessionKey, []);
        if (interrupts.length > 0) {
          const txt = interrupts.join("\n");
          messages.push(createUserEnvelope(`[USER INTERRUPT]\n${txt}`));
        }

        const systemPrompt = await this.promptBuilder.build(
          agent,
          messages,
          initialMsg
        );
        await this.emit("prompt:before", this, { messages, systemPrompt });

        let streamAccumulatedContent = "";

        const onChunk: StreamChunkCallback = (chunk) => {
          if (chunk.content) streamAccumulatedContent += chunk.content;
          this.emit("llm:chunk", this, {
            sessionKey,
            channel: skChannel,
            chunk,
          }).catch(() => {});
        };

        const chatParams = messages.map(envelopeToChatParam);

        let response: ChatCompletion;
        try {
          await this.emit("llm:before", this, { messages });
          response = await this.modelProvider.chat(
            systemPrompt,
            chatParams,
            tools.length > 0 ? tools : undefined,
            controller.signal,
            onChunk
          );
          await this.emit("llm:after", this, { response });
        } catch (err: any) {
          console.error(
            `[Kernel] LLM call error for session ${sessionKey}:`,
            err
          );
          if (err.name === "AbortError") {
            if (streamAccumulatedContent) {
              const truncated =
                streamAccumulatedContent + STREAM_INTERRUPT_MARKER;
              messages.push(createAssistantEnvelope(truncated));
            }
            this.emit("llm:chunk", this, {
              sessionKey,
              channel: skChannel,
              chunk: { finishReason: "interrupted" },
            }).catch(() => {});
            continue;
          }
          const handled = await this.emit("llm:error", this, {
            err,
            messages,
          });
          if (handled) continue;
          throw err;
        }

        const choice = response.choices[0];
        const assistantEnvelope = createAssistantEnvelope(
          choice.message.content || null,
          choice.message.tool_calls
        );
        messages.push(assistantEnvelope);
        this.logMessageThinking(choice.message);

        if (choice.finish_reason === "stop") {
          finalResponse = choice.message.content || "";
          break;
        } else if (choice.finish_reason === "tool_calls") {
          const toolCalls = choice.message.tool_calls || [];

          const callInfos: ToolCallInfo[] = toolCalls
            .filter((tc: any) => tc.type === "function")
            .map((tc: any) => ({
              id: tc.id,
              type: tc.type,
              functionName: tc.function.name,
              arguments: tc.function.arguments,
            }));

          const executor = new ToolExecutor(
            this,
            this.tools,
            this.toolConcurrency
          );
          const results = await executor.execute(callInfos, controller.signal);

          for (const r of results) {
            messages.push(
              createToolResultEnvelope(r.toolCallId, r.content, r.functionName)
            );
          }

          if (controller.signal.aborted) {
            const newController = new AbortController();
            this.processingSessions.set(sessionKey, {
              controller: newController,
            });
            continue;
          }

          continue;
        } else {
          finalResponse =
            choice.message.content || `[stop: ${choice.finish_reason}]`;
          break;
        }
      }
      if (i >= this.maxLoopIterations && !finalResponse) {
        finalResponse = `[stop: max loop (${this.maxLoopIterations})iterations reached]`;
      }
    } finally {
      this.processingSessions.delete(sessionKey);
      await this.sessionStore.save(sessionKey, messages);
      await this.emit("message:sent", this, {
        msg: initialMsg,
        response: finalResponse,
        sessionKey,
      });

      // Emit processing completed lifecycle hook
      await this.emit("session.processing_completed", this, {
        sessionKey,
        processingId,
      });

      if ((this.interruptQueues.get(sessionKey) || []).length > 0) {
        this.processSessionQueue(initialMsg, sessionKey);
      }
    }

    return this.postProcessMessage(finalResponse);
  }

  dispatchBackgroundMessage(msg: InboundMessage): void {
    this.backgroundQueue.push(msg);
  }

  private async processBackgroundMessages() {
    while (this.isRunning) {
      if (this.backgroundQueue.length === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const msg = this.backgroundQueue.shift()!;
      try {
        await this.handleMessage(msg);
      } catch (err) {
        console.error("[Kernel] Background message error:", err);
      }
    }
  }

  registerRouter(router: IRouter) {
    this.router = router;
  }
  registerSessionStore(store: ISessionStore) {
    this.sessionStore = store;
  }
  registerPromptBuilder(builder: IPromptBuilder) {
    this.promptBuilder = builder;
  }
  registerModelProvider(provider: IModelProvider) {
    this.modelProvider = provider;
  }
  registerAgent(agent: AgentConfig) {
    this.agents.set(agent.id, agent);
  }
  unregisterAgent(id: string): void {
    this.agents.delete(id);
  }
  registerTool(tool: ToolDef) {
    this.tools.set(tool.definition.function.name, tool);
  }
  registerAskUserHandler(channel: string, handler: AskUserHandler): void {
    this.askUserHandlers.set(channel, handler);
  }

  async askUser(
    question: string,
    options: string[],
    allowOther: boolean
  ): Promise<string> {
    const msg = messageContext.getStore();
    const channel = msg?.channel || "unknown";
    const handler = this.askUserHandlers.get(channel);

    if (!handler) {
      let result = `Question: ${question}\nOptions:\n`;
      options.forEach((opt, i) => {
        result += `  ${i + 1}. ${opt}\n`;
      });
      if (allowOther) result += "\nOr provide your own answer.";
      return (
        result +
        "\n\n[No interactive UI registered for this channel. Please answer in your next message.]"
      );
    }

    const context: AskUserContext = msg
      ? { channel: msg.channel, peerId: msg.peerId, senderId: msg.senderId }
      : { channel: "unknown", peerId: "unknown", senderId: "unknown" };

    return handler(question, options, allowOther, context);
  }

  on(hook: HookType | string, handler: HookHandler) {
    if (!this.hooks.has(hook)) this.hooks.set(hook, []);
    this.hooks.get(hook)!.push(handler);
  }

  async emit(hook: string, ctx: CoreContext, payload?: any): Promise<boolean> {
    const handlers = this.hooks.get(hook) || [];
    let result: any = false;
    for (const handler of handlers) {
      result = await handler(ctx, payload);
      if (result === true) break;
    }
    return result;
  }

  getAgent(id: string) {
    return this.agents.get(id);
  }
  listAgents() {
    return Array.from(this.agents.values());
  }
  getTools() {
    return Array.from(this.tools.values())
      .filter((t) => t.isEnabled !== false)
      .map((t) => t.definition);
  }

  provide<T>(key: string, instance: T): void {
    this.services.set(key, instance);
  }
  consume<T>(key: string): T {
    const service = this.services.get(key);
    if (!service) throw new Error(`Service '${key}' not provided.`);
    return service as T;
  }
  tryConsume<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  getWorkdir(): string {
    return this.workdir;
  }
  getWorkspace(): string {
    return this.workspace;
  }
  getProjectWorkspace(): string {
    return this.projectWorkspace;
  }
  getSessionStore() {
    return this.sessionStore;
  }
  getConfig(): AppConfig {
    return this.config;
  }

  resolveRouting(msg: InboundMessage): { agentId: string; sessionKey: string } {
    return this.router.resolve(msg);
  }
  getCurrentModelKey(): string {
    return this.config.activeModel;
  }
  getCurrentModelConfig(): ModelConfig {
    return resolveModelConfig(this.config);
  }

  switchModel(modelKey: string): void {
    if (!this.config.models[modelKey])
      throw new Error(`Model key '${modelKey}' not found in config.`);
    this.config.activeModel = modelKey;
    saveConfig(this.configPath, this.config);
    console.log(`[Kernel] Switched active model to: ${modelKey}`);
  }

  listModels(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(this.config.models)) {
      result[key] = `${entry.provider}/${entry.modelId}`;
    }
    return result;
  }

  async use(plugin: AgentPlugin) {
    this.plugins.push(plugin);
  }

  async start() {
    if (this.isRunning) return;
    for (const plugin of this.plugins) await plugin.install(this);
    if (
      !this.router ||
      !this.sessionStore ||
      !this.promptBuilder ||
      !this.modelProvider
    ) {
      throw new Error("Core capabilities missing.");
    }
    this.isRunning = true;
    await this.emit("startup", this);
    this.processBackgroundMessages();
  }

  async stop() {
    this.isRunning = false;
    this.destroyAllEphemeralSessions();
    await this.emit("shutdown", this);
  }

  destroyAllEphemeralSessions(): void {
    if (!this.sessionStore) return;
    const sessions = this.sessionStore.list();
    for (const s of sessions) {
      if (s.ephemeral) this.sessionStore.destroyEphemeral(s.key);
    }
  }

  getAbortController(sessionKey: string): AbortController | undefined {
    return this.processingSessions.get(sessionKey)?.controller;
  }

  isSessionProcessing(sessionKey: string): boolean {
    return this.processingSessions.has(sessionKey);
  }
}
