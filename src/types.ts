import type {
  ChatCompletionMessageParam,
  ChatCompletionFunctionTool,
  ChatCompletion,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

export interface InboundMessage {
  text: string;
  senderId: string;
  channel: string;
  accountId: string;
  peerId: string;
  isGroup: boolean;
  media: any[];
  raw: any;
}

export interface AgentConfig {
  id: string;
  name: string;
  model?: string;
  personality?: string;
  dmScope?: string;
}

export interface ToolDef {
  definition: ChatCompletionFunctionTool;
  handler: (args: any) => Promise<string>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  isEnabled?: boolean;
  interruptible?: boolean;
}

export interface ToolCallResult {
  toolCallId: string;
  functionName: string;
  content: string;
}

export interface ToolCallInfo {
  id: string;
  type: string;
  functionName: string;
  arguments: string;
}

export interface IFileTransactionManager {
  stageWrite(filePath: string, content: string): Promise<void>;
  stageDelete(filePath: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  exists(filePath: string): boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  readonly hasChanges: boolean;
}

export type ContentConverter = (
  content: string,
  contentType: string,
  url: string
) => Promise<string>;

export interface HookConfigEntry {
  event: string;
  command: string;
  silent?: boolean;
  injectTo?: "system_hint" | null;
}

export interface IRouter {
  resolve(msg: InboundMessage): { agentId: string; sessionKey: string };
}

export interface MessageEnvelope {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  createdAt: number;
  toolCalls?: ChatCompletionMessageToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ISessionStore {
  load(sessionKey: string): Promise<MessageEnvelope[]>;
  save(sessionKey: string, messages: MessageEnvelope[]): Promise<void>;
  list(): Array<{
    key: string;
    messageCount: number;
    ephemeral?: boolean;
    createdAt?: number;
    lastActiveAt?: number;
    metadata?: Record<string, any>;
  }>;
  clear(key: string): void;
  delete(key: string): void;
  estimateTokens(messages: MessageEnvelope[]): number;
  compact(
    messages: MessageEnvelope[],
    modelConfig?: ModelConfig
  ): Promise<MessageEnvelope[]>;
  markEphemeral(key: string): void;
  unmarkEphemeral(key: string): void;
  destroyEphemeral(key: string): void;
  isEphemeral(key: string): boolean;
  updateMetadata(key: string, metadata: Record<string, any>): void;
}

export interface IPromptBuilder {
  build(
    agent: AgentConfig,
    messages: MessageEnvelope[],
    msg: InboundMessage
  ): Promise<string>;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  functionName?: string;
  argumentsDelta?: string;
}

export interface StreamChunk {
  content?: string;
  toolCallDeltas?: StreamToolCallDelta[];
  finishReason?: string | null;
}

export type StreamChunkCallback = (chunk: StreamChunk) => void;

export interface IModelProvider {
  chat(
    system: string,
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionFunctionTool[],
    signal?: AbortSignal,
    onChunk?: StreamChunkCallback
  ): Promise<ChatCompletion>;
}

export type HookType =
  | "startup"
  | "shutdown"
  | "message:received"
  | "prompt:before"
  | "llm:before"
  | "llm:after"
  | "llm:error"
  | "llm:chunk"
  | "tool:before"
  | "tool:after"
  | "message:sent"
  | "session.processing_started"
  | "session.processing_completed";

export type HookHandler = (ctx: CoreContext, ...args: any[]) => Promise<any>;

export interface AgentPlugin {
  name: string;
  install(ctx: CoreContext): Promise<void>;
}

export interface ModelConfig {
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface ModelEntry {
  provider: string;
  modelId: string;
  maxTokens?: number;
}

export interface ChannelConfig {
  ephemeral: boolean;
  [key: string]: any;
}

export interface AgentEntry {
  name: string;
  personality?: string;
}

export interface StreamBufferConfig {
  enabled: boolean;
  flushIntervalMs: number;
  flushOnNewline: boolean;
}

export interface DefaultsConfig {
  maxTokens?: number;
  toolConcurrency?: number;
  maxLoopIterations?: number;
  heartbeatIntervalSeconds?: number;
  gatewayPort?: number;
  streamBuffer?: StreamBufferConfig;
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelEntry>;
  activeModel: string;
  channels: Record<string, ChannelConfig>;
  agents: Record<string, AgentEntry>;
  defaults: DefaultsConfig;
}

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  invocation: string;
  argumentHint?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  body: string;
  sourceDir: string;
}

export interface AskUserContext {
  channel: string;
  peerId: string;
  senderId: string;
}

export type AskUserHandler = (
  question: string,
  options: string[],
  allowOther: boolean,
  context: AskUserContext
) => Promise<string>;

// ── System Stats Types ───────────────────────────────────────

export interface SystemStats {
  uptime: number;
  totalSessions: number;
  activeProcessing: number;
  totalMessagesReceived: number;
  totalToolCalls: number;
  backgroundQueueSize: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
}

export interface ToolStatItem {
  name: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number;
  lastCalledAt: number;
}

// ── CoreContext ───────────────────────────────────────────────

export interface CoreContext {
  registerRouter(router: IRouter): void;
  registerSessionStore(store: ISessionStore): void;
  registerPromptBuilder(builder: IPromptBuilder): void;
  registerModelProvider(provider: IModelProvider): void;

  registerTool(tool: ToolDef): void;
  registerAgent(agent: AgentConfig): void;
  unregisterAgent(id: string): void;

  registerAskUserHandler(channel: string, handler: AskUserHandler): void;
  askUser(
    question: string,
    options: string[],
    allowOther: boolean
  ): Promise<string>;

  on(hook: HookType | string, handler: HookHandler): void;
  emit(hook: string, ctx: CoreContext, payload?: any): Promise<boolean>;

  dispatchBackgroundMessage(msg: InboundMessage): void;

  provide<T>(key: string, instance: T): void;
  consume<T>(key: string): T;
  tryConsume<T>(key: string): T | undefined;

  getAgent(id: string): AgentConfig | undefined;
  listAgents(): AgentConfig[];
  getTools(): ChatCompletionFunctionTool[];

  getWorkdir(): string;
  getWorkspace(): string;
  getProjectWorkspace(): string;
  getCurrentModelKey(): string;
  getCurrentModelConfig(): ModelConfig;
  switchModel(modelKey: string): void;
  listModels(): Record<string, string>;

  getEphemeralChannels(): Set<string>;
  getConfig(): AppConfig;
  resolveRouting(msg: InboundMessage): { agentId: string; sessionKey: string };

  getSessionStore(): ISessionStore;

  /**
   * Handle an inbound message.
   *
   * @param msg             The inbound message to process.
   * @param targetSessionKey  If provided, the message is dispatched to this
   *                          specific session instead of being routed via
   *                          the binding table. This lets callers (e.g. the
   *                          gateway `send` method) target an existing session
   *                          explicitly without depending on routing to
   *                          produce the same key again.
   */
  handleMessage(
    msg: InboundMessage,
    targetSessionKey?: string
  ): Promise<string>;

  /**
   * Enqueue a user message when the target session is already processing.
   *
   * @param msg             The inbound message to enqueue.
   * @param targetSessionKey  If provided, enqueue into this session rather
   *                          than re-routing.
   */
  enqueueUserMessage(msg: InboundMessage, targetSessionKey?: string): void;

  getAbortController(sessionKey: string): AbortController | undefined;
  isSessionProcessing(sessionKey: string): boolean;

  createSession(options: {
    channel?: string;
    peerId?: string;
    agentId?: string;
    ephemeral?: boolean;
  }): { sessionKey: string; agentId: string };

  deleteSession(sessionKey: string): void;
  regenerateSession(sessionKey: string): Promise<string>;

  // ── P1 & P2 New Methods ──────────────────────────
  forkSession(sessionKey: string, messageId: string): Promise<string>;
  editSessionMessage(
    sessionKey: string,
    messageId: string,
    newText: string
  ): Promise<string>;

  getStats(): SystemStats;
  getToolStats(): ToolStatItem[];

  updateConfig(path: string, value: any): void;
  updateSessionMetadata(
    sessionKey: string,
    metadata: Record<string, any>
  ): void;
}
