// ═══════════════════════════════════════════════════════════════
// Gateway JSON-RPC 2.0 over WebSocket — Protocol Reference
// ═══════════════════════════════════════════════════════════════
//
// 所有通信基于 JSON-RPC 2.0，单条 WebSocket 连接复用。
// 服务端地址默认 ws://localhost:8765，可通过 config.defaults.gatewayPort 配置。
//
// 连接建立后，服务端立即推送 connected 通知。
// 前端应先调用 register 声明自己负责的通道，否则 ask_user 等交互通知无法路由。
//
// ⚠️ 安全认证：所有 WS 连接和 HTTP 请求必须在 URL 中附带 ?token=xxx 参数。
// Token 在 Kernel 启动时随机生成并打印在控制台。
//
// ⚠️ 会话定位：强烈建议前端在 send / enqueue 时传入 sessionKey 参数，
// 以确保消息精准投递到目标会话。不传 sessionKey 时会走路由自动计算，
// 但路由结果取决于 channel + peerId + accountId 的组合，容易因参数不一致
// 而意外创建新会话。
//

// ─── 基础协议帧 ──────────────────────────────────────────────

/** 客户端 → 服务端：请求 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

/** 服务端 → 客户端：响应（成功） */
interface JsonRpcResult {
  jsonrpc: "2.0";
  id: number | string;
  result: any;
}

/** 服务端 → 客户端：响应（失败） */
interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

/** 服务端 → 客户端：通知（无 id，无需回复） */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, any>;
}

// 标准错误码：-32700 Parse error | -32600 Invalid Request | -32601 Method not found | -32603 Internal error | -32000 Unauthorized

// ─── 方法索引 ────────────────────────────────────────────────
//
// 连接    ping | register
// 消息    send | enqueue
// 交互    askUserRespond
// 模型    listModels | switchModel | getCurrentModel
// 工具    listTools
// 技能    listSkills | invokeSkill
// 会话    listSessions | clearSession | compactSession | getContext | sessionHistory | sessionInterrupt | session.create | session.delete | regenerate | session.fork | session.editMessage | session.updateMetadata
// 路由    listAgents | listBindings | resolveRoute
// 系统    getConfig | config.update | getWorkdir | listChannels | system.stats | system.toolStats
// 主动    listCronJobs | triggerCron | triggerHeartbeat | isSessionProcessing
// 缓冲    streamBuffer.getConfig | streamBuffer.updateConfig
// 文件    (HTTP) POST /upload
//

// ═══════════════════════════════════════════════════════════════
// §1 连接与认证
// ═══════════════════════════════════════════════════════════════

/**
 * 建立 WebSocket 连接时必须附带 token 参数：
 * ws://localhost:8765/?token=<your-token>
 *
 * 认证失败时，服务端会先推送一条 auth_failed 通知，再关闭连接（code 4001）。
 * 前端应监听此通知以区分"认证失败"和"网络断开"。
 *
 * Token 在 AgentKernel 每次启动时随机生成并输出到控制台。
 */

/** 心跳检测 */
type Ping = {
  method: "ping";
  result: { pong: true; timestamp: number };
};

/**
 * 声明本客户端负责的通道列表。
 * 调用后 gateway 会为这些通道注册 askUserHandler，
 * 使 ask_user 通知能路由到本客户端。
 * 建议连接后立即调用。
 */
type Register = {
  method: "register";
  params: {
    /** 本客户端能处理的通道名，如 ["cli","telegram"] */
    channels: string[];
  };
  result: {
    registered: true;
    channels: string[];
  };
};

// ═══════════════════════════════════════════════════════════════
// §2 消息
// ═══════════════════════════════════════════════════════════════

/**
 * 发送消息并启动 agent 处理。
 *
 * - 若会话空闲：启动流式处理，通过 stream_chunk + response 通知返回结果
 * - 若会话繁忙：自动降级为 enqueue（入队中断），返回 queued:true
 *
 * 该方法是异步的：响应仅表示"已受理"，实际内容通过通知推送。
 *
 * ⚠️ sessionKey 是核心参数：
 *   - 传入 sessionKey → 直接投递到指定会话，跳过路由计算
 *   - 不传 sessionKey → 根据 channel + peerId + accountId 走路由自动计算
 *   - 推荐做法：前端创建/选择会话后，后续 send 始终带 sessionKey
 *   - 不带 sessionKey 的 send 可能因路由参数不一致而意外创建新会话
 */
type Send = {
  method: "send";
  params: InboundMessageParams;
  result: SendAck;
};

/** 消息入参 */
interface InboundMessageParams {
  text: string;
  /**
   * 目标会话键。⚠️ 强烈建议传入！
   *
   * - 传入时：消息直接投递到该会话，不走路由，sessionKey 稳定可靠
   * - 不传时：由 channel + peerId + accountId 走路由计算，可能因参数不一致产生新会话
   *
   * 典型工作流：
   *   1. session.create → 拿到 sessionKey
   *   2. 后续 send 都带 sessionKey → 消息稳定进入同一会话
   */
  sessionKey?: string;
  /** 默认 "websocket" */
  channel?: string;
  /** 对端标识，如用户ID、群聊ID，用于会话隔离。默认 "ws-client" */
  peerId?: string;
  /** 发送者标识。默认 "ws-client" */
  senderId?: string;
  /** 账号标识，用于多账号路由。默认 "ws" */
  accountId?: string;
  isGroup?: boolean;
  /** 媒体文件数组，通过 /upload 接口获取 url 后传入 */
  media?: Array<{ type: string; url: string; [k: string]: any }>;
  raw?: Record<string, any>;
}

/** send 的立即回复 */
interface SendAck {
  /** 本次处理的唯一标识，用于关联后续 stream_chunk / response 通知 */
  processingId: string;
  /** 实际使用的会话键（若传了 sessionKey 则原样返回，否则为路由计算结果） */
  sessionKey: string;
  /** true=正在流式处理 */
  processing?: boolean;
  /** true=会话繁忙，已作为中断入队 */
  queued?: boolean;
}

/**
 * 将消息作为中断入队（不启动新处理）。
 * 如果会话正在处理，会触发 abort；处理循环会在下一轮消费队列。
 *
 * 与 send 一样，支持 sessionKey 参数以精确指定目标会话。
 */
type Enqueue = {
  method: "enqueue";
  params: InboundMessageParams;
  result: { queued: true; sessionKey: string };
};

// ═══════════════════════════════════════════════════════════════
// §3 交互：AskUser
// ═══════════════════════════════════════════════════════════════

/**
 * 响应 ask_user 通知。
 * 当 agent 调用 ask_user_question 工具时，gateway 会推送 ask_user 通知，
 * 前端展示选项后通过本方法回传用户选择。
 */
type AskUserRespond = {
  method: "askUserRespond";
  params: {
    /** ask_user 通知中的 questionId */
    questionId: string;
    /** 用户选择的选项文本，或自由输入 */
    answer: string;
  };
  result: { accepted: true };
};

// ═══════════════════════════════════════════════════════════════
// §4 模型
// ═══════════════════════════════════════════════════════════════

type ListModels = {
  method: "listModels";
  /** { [key]: "provider/modelId" } */
  result: Record<string, string>;
};

type SwitchModel = {
  method: "switchModel";
  params: { key: string };
  result: { activeModel: string };
};

type GetCurrentModel = {
  method: "getCurrentModel";
  result: {
    key: string;
    config: {
      modelId: string;
      baseUrl?: string;
      apiKey?: string;
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
    };
  };
};

// ═══════════════════════════════════════════════════════════════
// §5 工具 & 技能
// ═══════════════════════════════════════════════════════════════

type ListTools = {
  method: "listTools";
  /** OpenAI ChatCompletionFunctionTool[] */
  result: any[];
};

type ListSkills = {
  method: "listSkills";
  result: Array<{
    id: string;
    name: string;
    description: string;
    invocation: string;
    argumentHint?: string;
    disableModelInvocation: boolean;
    userInvocable: boolean;
    allowedTools: string[];
  }>;
};

type InvokeSkill = {
  method: "invokeSkill";
  params: {
    /** 技能名或调用名，如 "example" 或 "/example" */
    name: string;
    /** 可选参数 */
    arguments?: string;
  };
  result: {
    /** 渲染后的完整技能内容，可作为消息发送给 agent */
    content: string;
    skill: { name: string; invocation: string; description: string };
  };
};

// ═══════════════════════════════════════════════════════════════
// §6 会话
// ═══════════════════════════════════════════════════════════════

/**
 * Session Key 格式：agent:<agentId>:<channel>:<peerId>
 *
 * 该格式是稳定的——同一个 sessionKey 在多次请求间不会变化。
 * 前端应将 sessionKey 视为不透明字符串，不需要解析其内部结构。
 *
 * 重要：send / enqueue 时传入 sessionKey 可确保消息精准投递，
 * 不传则走路由计算，可能因参数不一致而创建新会话。
 */

/** 消息信封结构，历史记录中的标准消息格式 */
interface MessageEnvelope {
  /** 消息唯一ID，用于编辑、分叉和引用。每条消息必定有此字段。 */
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  createdAt: number;
  /** assistant 消息可能包含工具调用 */
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** tool 消息关联的工具调用ID */
  toolCallId?: string;
  /** tool 消息的函数名 */
  name?: string;
}

type ListSessions = {
  method: "listSessions";
  result: Array<{
    key: string;
    messageCount: number;
    /** 临时会话标记，临时会话在处理完或重启后自动销毁 */
    ephemeral: boolean;
    /** 创建时间戳(ms)，若无记录则为 null */
    createdAt: number | null;
    /** 最后活跃时间戳(ms)，若无记录则为 null */
    lastActiveAt: number | null;
    /** 会话元数据（如自定义标题、置顶等），至少为 {} */
    metadata: Record<string, any>;
  }>;
};

type ClearSession = {
  method: "clearSession";
  params: { key: string };
  result: { cleared: true };
};

type CompactSession = {
  method: "compactSession";
  params: { key: string };
  result: { from: number; to: number };
};

type GetContext = {
  method: "getContext";
  params: { key: string };
  result: { tokens: number; messages: number; sessionKey: string };
};

/**
 * 获取会话的完整消息历史。
 * 支持游标分页，用于前端向上滚动懒加载。
 *
 * 返回的每条消息保证有 id 字段，可用于 editMessage / fork 操作。
 */
type SessionHistory = {
  method: "sessionHistory";
  params: {
    /** 会话键 */
    key: string;
    /** 返回最近 N 条消息，0 或不传表示返回全部 */
    limit?: number;
    /** 获取指定索引之前的历史（用于向上滚动加载），-1 或不传表示从最新开始 */
    beforeIndex?: number;
  };
  result: {
    sessionKey: string;
    /** MessageEnvelope[]，每条消息保证有全局唯一的 id */
    messages: MessageEnvelope[];
    /** 该会话的总消息数（不受 limit 影响） */
    totalMessages: number;
    /** 估算的 Token 数 */
    tokenEstimate: number;
  };
};

/**
 * 主动中断指定会话的当前处理。
 * 如果会话正在流式生成，会触发 AbortController 截断当前流。
 */
type SessionInterrupt = {
  method: "sessionInterrupt";
  params: {
    /** 要中断的会话键 */
    sessionKey: string;
  };
  result: {
    /** true=中断成功，false=中断失败 */
    ok: boolean;
    sessionKey: string;
    /** 若 ok=false，给出原因，如 "not_processing" */
    reason?: string;
  };
};

/**
 * 显式创建一个新会话。
 * 前端侧边栏"新建对话"按钮的基石。支持创建临时(Ephemeral)会话。
 * 创建成功后服务端会广播 session.created 通知。
 */
type SessionCreate = {
  method: "session.create";
  params: {
    channel?: string;
    peerId?: string; // 不传则自动生成随机ID
    agentId?: string; // 不传则走路由规则
    /** 是否为临时会话，临时会话在处理完或重启后自动销毁 */
    ephemeral?: boolean;
  };
  result: { sessionKey: string; agentId: string };
};

/**
 * 彻底删除一个会话及其历史记录。
 * 删除成功后服务端会广播 session.deleted 通知。
 */
type SessionDelete = {
  method: "session.delete";
  params: { sessionKey: string };
  result: { deleted: true };
};

/**
 * 重新生成最后一条回复。
 * 删除最后一条 assistant 消息，并使用最后一条 user 消息重新触发 LLM。
 */
type Regenerate = {
  method: "regenerate";
  params: {
    sessionKey: string;
    /** 可选：换用其他模型重新生成 */
    model?: string;
  };
  result: { processingId: string; sessionKey: string; processing: true };
};

/**
 * 会话分叉：从指定的消息位置创建一个新会话。
 * 探索性对话的杀手锏，类似"从这里开始试试另一条路"。
 * 分叉成功后服务端会广播 session.created 通知（含 forkedFrom）。
 */
type SessionFork = {
  method: "session.fork";
  params: {
    sessionKey: string;
    /** 分叉点的 Message ID，该消息及之前的记录将被复制到新会话 */
    messageId: string;
  };
  result: {
    newSessionKey: string;
  };
};

/**
 * 编辑历史消息并重放。
 * 截断该消息之后的历史，修改该消息内容，并从该点重新触发 LLM 处理。
 * 仅允许编辑 role="user" 的消息。
 */
type SessionEditMessage = {
  method: "session.editMessage";
  params: {
    sessionKey: string;
    /** 要编辑的消息 ID（来自 MessageEnvelope.id） */
    messageId: string;
    /** 修改后的文本内容 */
    newText: string;
  };
  result: { processingId: string; sessionKey: string; processing: true };
};

/**
 * 更新会话元数据。
 * 用于前端自定义会话标题、置顶、标签等展示属性。
 */
type SessionUpdateMetadata = {
  method: "session.updateMetadata";
  params: {
    sessionKey: string;
    /** 自定义键值对，如 { title: "新对话", pinned: true } */
    metadata: Record<string, any>;
  };
  result: { updated: true };
};

// ═══════════════════════════════════════════════════════════════
// §7 路由 & Agent
// ═══════════════════════════════════════════════════════════════

type ListAgents = {
  method: "listAgents";
  result: Array<{ id: string; name: string; personality?: string }>;
};

type ListBindings = {
  method: "listBindings";
  result: Array<{
    agentId: string;
    tier: number;
    matchKey: string;
    matchValue: string;
    priority: number;
  }>;
};

type ResolveRoute = {
  method: "resolveRoute";
  params: { channel?: string; peerId?: string; accountId?: string };
  result: { agentId: string; sessionKey: string };
};

// ═══════════════════════════════════════════════════════════════
// §8 系统 & 配置
// ═══════════════════════════════════════════════════════════════

type GetConfig = {
  method: "getConfig";
  /** 完整 AppConfig 对象（apiKey 已脱敏，显示前6位+...+后4位） */
  result: any;
};

/**
 * 运行时动态修改配置。
 * 支持点分路径修改深层配置，修改后自动持久化到 config.json。
 */
type ConfigUpdate = {
  method: "config.update";
  params: {
    /** 点分路径，如 "providers.openai.apiKey" 或 "defaults.maxTokens" */
    path: string;
    /** 新值 */
    value: any;
  };
  result: { updated: true; path: string };
};

type GetWorkdir = {
  method: "getWorkdir";
  result: { workdir: string; workspace: string; projectWorkspace: string };
};

type ListChannels = {
  method: "listChannels";
  result: Array<{ id: string; ephemeral: boolean; [k: string]: any }>;
};

// ═══════════════════════════════════════════════════════════════
// §9 可观测性 (Observability)
// ═══════════════════════════════════════════════════════════════

/** 获取系统宏观统计 */
type SystemStats = {
  method: "system.stats";
  result: {
    uptime: number;
    totalSessions: number;
    activeProcessing: number;
    totalMessagesReceived: number;
    totalToolCalls: number;
    backgroundQueueSize: number;
    memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  };
};

/** 获取工具调用统计，用于监控工具健康度和耗时 */
type SystemToolStats = {
  method: "system.toolStats";
  result: Array<{
    name: string;
    callCount: number;
    errorCount: number;
    avgDurationMs: number;
    lastCalledAt: number;
  }>;
};

// ═══════════════════════════════════════════════════════════════
// §10 主动任务
// ═══════════════════════════════════════════════════════════════

type ListCronJobs = {
  method: "listCronJobs";
  result: Array<{
    id: string;
    name: string;
    enabled: boolean;
    scheduleKind: "at" | "every" | "cron";
    nextRunAt: number;
  }>;
};

type TriggerCron = {
  method: "triggerCron";
  params: { id: string };
  result: { triggered: true };
};

type TriggerHeartbeat = {
  method: "triggerHeartbeat";
  result: { triggered: true };
};

type IsSessionProcessing = {
  method: "isSessionProcessing";
  params: { sessionKey: string };
  result: { processing: boolean };
};

// ═══════════════════════════════════════════════════════════════
// §11 流式缓冲 (Stream Buffer)
// ═══════════════════════════════════════════════════════════════

/**
 * 默认配置：enabled=true, flushIntervalMs=100, flushOnNewline=true
 * flushIntervalMs 从旧版的 1000ms 降为 100ms，确保前端能快速看到流式输出。
 */

/** 获取当前流式缓冲配置 */
type StreamBufferGetConfig = {
  method: "streamBuffer.getConfig";
  result: {
    enabled: boolean;
    flushIntervalMs: number;
    flushOnNewline: boolean;
  };
};

/** 动态更新流式缓冲配置 */
type StreamBufferUpdateConfig = {
  method: "streamBuffer.updateConfig";
  params: {
    enabled?: boolean;
    flushIntervalMs?: number;
    flushOnNewline?: boolean;
  };
  result: {
    enabled: boolean;
    flushIntervalMs: number;
    flushOnNewline: boolean;
  };
};

// ═══════════════════════════════════════════════════════════════
// §12 文件上传 (HTTP)
// ═══════════════════════════════════════════════════════════════

/**
 * POST /upload?token=xxx
 *
 * 用于上传富媒体文件（图片、PDF等），供多模态Agent使用。
 * 请求体为文件的二进制流。
 *
 * Headers:
 *   Content-Type: 文件的MIME类型 (如 image/png)
 *   X-Filename: 原始文件名 (可选)
 *
 * Response:
 *   { fileId: "file_xxx", url: "ws://localhost:8765/uploads/file_xxx.png", filename: "xxx.png" }
 *
 * 使用方式：
 *   前端通过 HTTP 上传获得 url 后，在 send 方法中将 url 放入 media 数组传递。
 */

// ═══════════════════════════════════════════════════════════════
// §13 服务端通知
// ═══════════════════════════════════════════════════════════════

/** 连接成功后立即推送 */
interface ConnectedNotification {
  method: "connected";
  params: { version: string };
}

/**
 * 认证失败通知。
 * 在 WS 连接因 token 无效而关闭前推送，前端可据此区分"认证失败"和"网络断开"。
 * 收到后连接会被服务端关闭（code 4001）。
 */
interface AuthFailedNotification {
  method: "auth_failed";
  params: { reason: string; code: number };
}

/**
 * 流式增量通知。
 * 受 StreamBuffer 配置影响，默认每 100ms 或遇到换行符时批量推送。
 * finishReason 非 null 时表示流结束。
 */
interface StreamChunkNotification {
  method: "stream_chunk";
  params: {
    /** 与 send 返回的 processingId 一致，用于关联请求 */
    processingId: string;
    /** 与 send 返回的 sessionKey 一致 */
    sessionKey: string;
    /** 文本增量，可能包含多个 token */
    delta: string | null;
    /** 工具调用增量 */
    toolCallDeltas: Array<{
      index: number;
      id?: string;
      functionName?: string;
      argumentsDelta?: string;
    }> | null;
    /** 结束原因：stop=正常结束, tool_calls=需调用工具, interrupted=用户中断 */
    finishReason: "stop" | "tool_calls" | "interrupted" | null;
  };
}

/**
 * 最终响应通知。
 * 标志本次 processingId 的处理流程结束（无论成功或失败）。
 */
interface ResponseNotification {
  method: "response";
  params: {
    /** 与 send 返回的 processingId 一致 */
    processingId: string;
    /** 与 send 返回的 sessionKey 一致 */
    sessionKey: string;
    /** 最终文本响应（可能为空字符串） */
    response?: string;
    /** 错误信息（处理失败时） */
    error?: string;
    /** 是否被降级入队 */
    queued?: boolean;
  };
}

/**
 * AskUser 交互通知。
 */
interface AskUserNotification {
  method: "ask_user";
  params: {
    questionId: string;
    question: string;
    options: string[];
    allowOther: boolean;
    context: {
      channel: string;
      peerId: string;
      senderId: string;
    };
  };
}

/**
 * 会话处理开始通知。
 * processingId 可与 send 返回值关联。
 */
interface SessionProcessingStartedNotification {
  method: "session.processing_started";
  params: { sessionKey: string; processingId: string };
}

/**
 * 会话处理完成通知。
 * processingId 可与 send 返回值关联。
 */
interface SessionProcessingCompletedNotification {
  method: "session.processing_completed";
  params: { sessionKey: string; processingId: string };
}

/**
 * 会话被创建通知。
 * 在 session.create、session.fork 成功后广播给所有连接的客户端，
 * 方便前端实时刷新会话列表而无需轮询。
 */
interface SessionCreatedNotification {
  method: "session.created";
  params: {
    sessionKey: string;
    /** 若为分叉产生，记录来源会话；否则为 null */
    forkedFrom: string | null;
    agentId: string;
  };
}

/** 会话被删除通知 */
interface SessionDeletedNotification {
  method: "session.deleted";
  params: { sessionKey: string };
}

// ═══════════════════════════════════════════════════════════════
// §14 流程示意
// ═══════════════════════════════════════════════════════════════

/**
 * ── 推荐工作流：先创建会话，再带 sessionKey 发消息 ─────
 *
 *  Frontend                    Gateway
 *  │                            │
 *  │── session.create ─────────>│  返回 { sessionKey, agentId }
 *  │<── session.created ───────│  (广播，所有客户端收到)
 *  │                            │
 *  │── send {text, sessionKey} >│  返回 {processingId, processing:true}
 *  │<── session.processing_started ──│
 *  │<── stream_chunk {delta} ──│  (缓冲后批量推送)
 *  │<── stream_chunk {finishReason:"stop"} ──│
 *  │<── session.processing_completed ──│
 *  │<── response {response} ───│
 *  │                            │
 *  │── send {text, sessionKey} >│  同一个 sessionKey，同一个会话 ✓
 *  │<── stream_chunk ... ──────│
 *  │<── response {response} ───│
 *
 * ── 旧工作流（不推荐）：不带 sessionKey 发消息 ───────
 *
 *  │── send {text, channel:"ws"} ──>│  路由自动计算 sessionKey
 *  │<── {sessionKey: "agent:main:ws:ws-client"} ──│
 *  │                            │
 *  │── send {text, channel:"ws"} ──>│  ⚠️ 如果参数不完全一致，可能产生不同 sessionKey！
 *  │<── {sessionKey: "agent:main:ws:ws-client"} ──│  (这次碰巧一样)
 *  │                            │
 *  │── send {text} ────────────>│  ⚠️ 默认 channel="websocket"，与之前不同！
 *  │<── {sessionKey: "agent:main:websocket:ws-client"} ──│  新会话！
 *
 * ── 编辑并重放 ──────────────────────────────────
 *
 *  │── session.editMessage {sessionKey, messageId, newText} ──>│
 *  │<── {processingId, processing: true} ──│
 *  │<── session.processing_started ──│
 *  │<── stream_chunk ... ───────│  从编辑点重新生成
 *  │<── session.processing_completed ──│
 *  │<── response {response} ────│
 *
 * ── 会话分叉 ────────────────────────────────────
 *
 *  │── session.fork {sessionKey, messageId} ────>│
 *  │<── {newSessionKey} ────────│  原会话不受影响
 *  │<── session.created {sessionKey: newSessionKey, forkedFrom} ──│ (广播)
 *
 * ── 认证失败 ────────────────────────────────────
 *
 *  │── WS connect ?token=wrong ─>│
 *  │<── auth_failed {reason, code:4001} ──│  先推通知再断开
 *  │     (connection closed) ───│  Close code 4001
 *
 * ── 上传文件并引用 ──────────────────────────────
 *
 *  │── HTTP POST /upload?token=xxx (binary) ──>│
 *  │<── {fileId, url} ─────────│
 *  │── send {text:"看图", sessionKey, media: [{type:"image", url}]} ──>│
 *  │<── stream_chunk ... ──────│
 */

// ═══════════════════════════════════════════════════════════════
// §15 前端实现要点
// ═══════════════════════════════════════════════════════════════

/**
 * 1. 认证与重连
 *    - WS 连接 URL 必须附带 ?token=xxx
 *    - 认证失败时先收到 auth_failed 通知，再断开（code 4001）
 *    - 前端应区分 auth_failed 和普通网络断开，前者应提示用户检查 token
 *    - 断线后应自动重连 + 重新 register
 *    - 重连期间的消息可本地缓存，重连后 enqueue 补发
 *
 * 2. 会话定位（⚠️ 核心变更）
 *    - 前端应维护一个"当前活跃会话"状态（activeSessionKey）
 *    - 每次调用 send / enqueue 时传入 sessionKey，确保消息投递到正确会话
 *    - 不传 sessionKey 的 send 会走路由计算，可能因 channel/peerId 参数不一致而意外创建新会话
 *    - 推荐流程：session.create → 保存 sessionKey → 后续操作都带 sessionKey
 *
 * 3. 消息 ID 与 IM 模式
 *    - 历史记录中的消息是 MessageEnvelope，保证每条都有全局唯一的 `id`
 *    - 任何针对历史消息的操作（编辑、分叉）必须基于 `id`，而非数组下标
 *    - editMessage 只能修改 user 角色，修改后会截断后续历史并重新生成
 *    - fork 会保留原消息到分叉点的记录，原会话不受影响
 *
 * 4. 会话生命周期
 *    - 使用 session.create 显式创建会话（支持 ephemeral 临时会话）
 *    - 创建后监听 session.created 通知来刷新会话列表（无需轮询）
 *    - 使用 session.delete 彻底删除会话（clearSession 只清空内容保留壳）
 *    - 删除后监听 session.deleted 通知来更新 UI
 *    - 监听 session.processing_started / session.processing_completed 通知来管理前端 Loading 状态
 *    - 这两个通知都包含 processingId，可与 send 返回值关联
 *
 * 5. 流式渲染与缓冲
 *    - stream_chunk 通知中的 sessionKey 和 processingId 与 send 返回值一致
 *    - 默认缓冲间隔 100ms（旧版 1000ms），遇换行符立即刷新
 *    - 可通过 streamBuffer.updateConfig 动态调整推送频率
 *    - finishReason="stop" 表示流结束，后续会收到 response 通知
 *
 * 6. 富媒体与文件上传
 *    - 文件必须先通过 HTTP POST /upload 上传，获取 url
 *    - 然后在 send 的 media 数组中引用该 url
 *
 * 7. 可观测性
 *    - 调用 system.stats 查看系统运行状态（每 5 秒轮询即可）
 *    - 调用 system.toolStats 监控工具调用耗时与错误率
 *    - 这两个方法已稳定实现，不会返回 Method not found 错误
 *
 * 8. listSessions 返回字段完整性
 *    - 每个会话对象保证包含：key, messageCount, ephemeral, createdAt, lastActiveAt, metadata
 *    - createdAt / lastActiveAt 可能为 null（无记录的旧会话）
 *    - metadata 至少为 {}（不会是 undefined）
 */
