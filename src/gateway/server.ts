import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import type { AgentKernel } from "../kernel";
import type { InboundMessage, AskUserHandler, AskUserContext } from "../types";
import type { SkillsManager } from "../skills/skills-manager";
import {
  type JsonRpcRequest,
  StandardErrors,
  CustomErrors,
  makeSuccessResponse,
  makeErrorResponse,
  makeNotification,
} from "./json-rpc";

// ── Internal Types ─────────────────────────────────────────

interface ClientConnection {
  id: string;
  ws: WebSocket;
  subscribedSessions: Set<string>;
  registeredChannels: Set<string>;
  metadata: Record<string, any>;
}

interface PendingQuestion {
  questionId: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
  connectionId: string;
}

interface ActiveRequest {
  connectionId: string;
  requestId: string | number | null;
}

// ── GatewayServer ──────────────────────────────────────────

export class GatewayServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private kernel!: AgentKernel;
  private port: number;

  /** sessionKey → latest active request metadata */
  private sessionRequests = new Map<string, ActiveRequest>();

  /** questionId → pending ask_user promise */
  private pendingQuestions = new Map<string, PendingQuestion>();

  constructor(port = 8765) {
    this.port = port;
  }

  // ── Lifecycle ──────────────────────────────────────────

  setKernel(kernel: AgentKernel) {
    this.kernel = kernel;
    this.registerHooks();
    this.registerAskUserHandlers();
  }

  async start() {
    this.wss = new WebSocketServer({ port: this.port });
    console.log(
      `[Gateway] JSON-RPC WebSocket server started on ws://localhost:${this.port}`
    );

    this.wss.on("connection", (ws) => {
      const connectionId = this.generateId();
      const client: ClientConnection = {
        id: connectionId,
        ws,
        subscribedSessions: new Set(),
        registeredChannels: new Set(["gateway"]),
        metadata: {},
      };
      this.clients.set(connectionId, client);

      this.sendNotification(ws, "gateway.connected", { connectionId });

      ws.on("message", (data) => this.handleRawMessage(connectionId, data));
      ws.on("close", () => this.handleDisconnect(connectionId));
      ws.on("error", (err) => {
        console.error(
          `[Gateway] Connection ${connectionId} error:`,
          err.message
        );
      });
    });
  }

  async stop() {
    for (const [, pq] of this.pendingQuestions) {
      clearTimeout(pq.timer);
      pq.resolve("[Gateway shutting down]");
    }
    this.pendingQuestions.clear();

    for (const [, client] of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
    this.sessionRequests.clear();

    if (this.wss) this.wss.close();
  }

  // ── Connection Handling ────────────────────────────────

  private handleDisconnect(connectionId: string) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    // Clean up subscriptions
    for (const sk of client.subscribedSessions) {
      const req = this.sessionRequests.get(sk);
      if (req && req.connectionId === connectionId) {
        this.sessionRequests.delete(sk);
      }
    }

    // Resolve pending questions for this connection
    for (const [qid, pq] of this.pendingQuestions) {
      if (pq.connectionId === connectionId) {
        clearTimeout(pq.timer);
        pq.resolve("[Client disconnected]");
        this.pendingQuestions.delete(qid);
      }
    }

    this.clients.delete(connectionId);
    console.log(`[Gateway] Client ${connectionId} disconnected`);
  }

  private handleRawMessage(connectionId: string, data: any) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(data.toString());
    } catch {
      this.sendToSocket(
        client.ws,
        makeErrorResponse(null, StandardErrors.PARSE_ERROR, "Parse error")
      );
      return;
    }

    if (!request.jsonrpc || typeof request.method !== "string") {
      this.sendToSocket(
        client.ws,
        makeErrorResponse(
          request.id ?? null,
          StandardErrors.INVALID_REQUEST,
          "Invalid Request"
        )
      );
      return;
    }

    // Notifications (no id) — fire and forget
    if (request.id === undefined || request.id === null) {
      this.processMethod(
        connectionId,
        request.method,
        request.params || {}
      ).catch(() => {});
      return;
    }

    // Request with id — must respond
    this.processMethod(connectionId, request.method, request.params || {})
      .then((result) => {
        this.sendToSocket(client.ws, makeSuccessResponse(request.id, result));
      })
      .catch((err: any) => {
        this.sendToSocket(
          client.ws,
          makeErrorResponse(
            request.id,
            err?.code ?? StandardErrors.INTERNAL_ERROR,
            err?.message ?? "Internal error"
          )
        );
      });
  }

  // ── Method Routing ─────────────────────────────────────

  private async processMethod(
    connectionId: string,
    method: string,
    params: any
  ): Promise<any> {
    switch (method) {
      // ── System ──
      case "system.ping":
        return { pong: true, timestamp: Date.now() };
      case "system.info":
        return this.systemInfo();

      // ── Session ──
      case "session.send":
        return this.sessionSend(connectionId, params);
      case "session.interrupt":
        return this.sessionInterrupt(params);
      case "session.list":
        return this.sessionList();
      case "session.clear":
        return this.sessionClear(params);
      case "session.compact":
        return this.sessionCompact(params);
      case "session.history":
        return this.sessionHistory(params);
      case "session.subscribe":
        return this.sessionSubscribe(connectionId, params);
      case "session.unsubscribe":
        return this.sessionUnsubscribe(connectionId, params);

      // ── Model ──
      case "model.list":
        return this.modelList();
      case "model.switch":
        return this.modelSwitch(params);
      case "model.current":
        return this.modelCurrent();

      // ── Agent ──
      case "agent.list":
        return this.agentList();
      case "agent.get":
        return this.agentGet(params);

      // ── Tool ──
      case "tool.list":
        return this.toolList();

      // ── Skill ──
      case "skill.list":
        return this.skillList();
      case "skill.invoke":
        return this.skillInvoke(connectionId, params);

      // ── Memory ──
      case "memory.search":
        return this.memorySearch(params);
      case "memory.write":
        return this.memoryWrite(params);

      // ── Config ──
      case "config.get":
        return this.configGet();

      // ── Channel ──
      case "channel.list":
        return this.channelList();
      case "channel.register":
        return this.channelRegister(connectionId, params);

      // ── Cron ──
      case "cron.list":
        return this.cronList();
      case "cron.trigger":
        return this.cronTrigger(params);

      // ── Heartbeat ──
      case "heartbeat.status":
        return this.heartbeatStatus();
      case "heartbeat.trigger":
        return this.heartbeatTrigger();

      // ── AskUser ──
      case "ask_user.answer":
        return this.askUserAnswer(params);

      default:
        throw Object.assign(new Error(`Method not found: ${method}`), {
          code: StandardErrors.METHOD_NOT_FOUND,
        });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — System
  // ═══════════════════════════════════════════════════════

  private systemInfo() {
    const config = this.kernel.getConfig();
    return {
      workdir: this.kernel.getWorkdir(),
      workspace: this.kernel.getWorkspace(),
      projectWorkspace: this.kernel.getProjectWorkspace(),
      activeModel: this.kernel.getCurrentModelKey(),
      modelConfig: this.kernel.getCurrentModelConfig(),
      agents: this.kernel.listAgents().map((a) => a.id),
      channels: Array.from(this.kernel.getEphemeralChannels()),
      connectedClients: this.clients.size,
      uptime: process.uptime(),
      defaults: config.defaults,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Session
  // ═══════════════════════════════════════════════════════

  private sessionSend(
    connectionId: string,
    params: {
      text: string;
      channel?: string;
      peerId?: string;
      senderId?: string;
      accountId?: string;
      isGroup?: boolean;
      agentId?: string;
      sessionKey?: string;
    }
  ) {
    if (!params.text) {
      throw Object.assign(new Error("text is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }

    const channel = params.channel || "gateway";
    const peerId = params.peerId || `gw:${connectionId}`;
    const effectivePeerId = params.agentId
      ? `agent:${params.agentId}:${peerId}`
      : peerId;

    const msg: InboundMessage = {
      text: params.text,
      senderId: params.senderId || connectionId,
      channel,
      accountId: params.accountId || "gateway",
      peerId: effectivePeerId,
      isGroup: params.isGroup || false,
      media: [],
      raw: {},
    };

    // Determine the target session key
    let sessionKey: string;
    if (params.sessionKey) {
      // Explicit session — bypass routing entirely
      sessionKey = params.sessionKey;
    } else {
      const resolved = this.kernel.resolveRouting(msg);
      sessionKey = resolved.sessionKey;
    }

    const requestId = this.generateId();

    // Notify previous requester if session was already processing
    const wasProcessing = this.kernel.isSessionProcessing(sessionKey);
    if (wasProcessing) {
      const prevReq = this.sessionRequests.get(sessionKey);
      if (prevReq) {
        this.pushNotification(prevReq.connectionId, "session.interrupted", {
          sessionKey,
          requestId: prevReq.requestId,
          reason: "new_message",
        });
      }
    }

    // Track this request
    this.sessionRequests.set(sessionKey, {
      connectionId,
      requestId,
    });

    // Auto-subscribe the sender
    const client = this.clients.get(connectionId);
    if (client) client.subscribedSessions.add(sessionKey);

    // Start processing (non-blocking) — pass explicit sessionKey
    this.kernel.handleMessage(msg, sessionKey).catch((err) => {
      this.pushToSessionSubscribers(sessionKey, "session.error", {
        sessionKey,
        requestId,
        error: { message: err.message },
      });
    });

    return {
      sessionKey,
      requestId,
      status: wasProcessing ? "interrupted" : "processing",
    };
  }

  private sessionInterrupt(params: { sessionKey: string }) {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw Object.assign(new Error("sessionKey is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }

    const controller = this.kernel.getAbortController(sessionKey);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return { ok: true, sessionKey };
    }
    return { ok: false, sessionKey, reason: "not_processing" };
  }

  private sessionList() {
    const raw = this.kernel.getSessionStore().list();
    const sessions = raw.map((s) => ({
      key: s.key,
      messageCount: s.messageCount ?? 0,
      ephemeral: s.ephemeral ?? false,
      createdAt: s.createdAt ?? null,
      lastActiveAt: s.lastActiveAt ?? null,
      metadata: s.metadata ?? {},
    }));
    return { sessions };
  }

  private sessionClear(params: { sessionKey: string }) {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw Object.assign(new Error("sessionKey is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    this.kernel.getSessionStore().clear(sessionKey);
    return { ok: true };
  }

  private async sessionCompact(params: { sessionKey: string }) {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw Object.assign(new Error("sessionKey is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const store = this.kernel.getSessionStore();
    const msgs = await store.load(sessionKey);
    const before = msgs.length;
    const modelConfig = this.kernel.getCurrentModelConfig();
    const compacted = await store.compact(msgs, modelConfig);
    await store.save(sessionKey, compacted);
    return { ok: true, before, after: compacted.length };
  }

  private async sessionHistory(params: { sessionKey: string }) {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw Object.assign(new Error("sessionKey is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const store = this.kernel.getSessionStore();
    const messages = await store.load(sessionKey);
    const tokenEstimate = store.estimateTokens(messages);
    return { sessionKey, messages, tokenEstimate };
  }

  private sessionSubscribe(
    connectionId: string,
    params: { sessionKey: string }
  ) {
    const { sessionKey } = params;
    if (!sessionKey) {
      throw Object.assign(new Error("sessionKey is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const client = this.clients.get(connectionId);
    if (client) {
      client.subscribedSessions.add(sessionKey);
      return { ok: true, sessionKey };
    }
    throw Object.assign(new Error("Connection not found"), {
      code: CustomErrors.KERNEL_NOT_READY,
    });
  }

  private sessionUnsubscribe(
    connectionId: string,
    params: { sessionKey: string }
  ) {
    const { sessionKey } = params;
    const client = this.clients.get(connectionId);
    if (client) {
      client.subscribedSessions.delete(sessionKey);
      return { ok: true, sessionKey };
    }
    return { ok: false };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Model
  // ═══════════════════════════════════════════════════════

  private modelList() {
    const models = this.kernel.listModels();
    const active = this.kernel.getCurrentModelKey();
    return { models, active };
  }

  private modelSwitch(params: { key: string }) {
    if (!params.key) {
      throw Object.assign(new Error("key is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    this.kernel.switchModel(params.key);
    return { ok: true, active: params.key };
  }

  private modelCurrent() {
    return {
      key: this.kernel.getCurrentModelKey(),
      config: this.kernel.getCurrentModelConfig(),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Agent
  // ═══════════════════════════════════════════════════════

  private agentList() {
    return { agents: this.kernel.listAgents() };
  }

  private agentGet(params: { id: string }) {
    const agent = this.kernel.getAgent(params.id);
    if (!agent) {
      throw Object.assign(new Error(`Agent '${params.id}' not found`), {
        code: CustomErrors.AGENT_NOT_FOUND,
      });
    }
    return { agent };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Tool
  // ═══════════════════════════════════════════════════════

  private toolList() {
    const tools = this.kernel.getTools();
    return {
      tools: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Skill
  // ═══════════════════════════════════════════════════════

  private skillList() {
    const skillsMgr = this.kernel.tryConsume<SkillsManager>("skills");
    if (!skillsMgr) return { skills: [] };
    return {
      skills: skillsMgr.skills.map((s) => ({
        id: s.id,
        name: s.name,
        invocation: s.invocation,
        argumentHint: s.argumentHint,
        description: s.description,
        disableModelInvocation: s.disableModelInvocation,
        userInvocable: s.userInvocable,
        allowedTools: s.allowedTools,
      })),
    };
  }

  private async skillInvoke(
    connectionId: string,
    params: {
      name: string;
      arguments?: string;
      channel?: string;
      peerId?: string;
      sessionKey?: string;
    }
  ) {
    if (!params.name) {
      throw Object.assign(new Error("name is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }

    const skillsMgr = this.kernel.tryConsume<SkillsManager>("skills");
    if (!skillsMgr) {
      throw Object.assign(new Error("Skills system not available"), {
        code: CustomErrors.KERNEL_NOT_READY,
      });
    }

    const skill = skillsMgr.findByName(params.name);
    if (!skill) {
      throw Object.assign(new Error(`Skill '${params.name}' not found`), {
        code: CustomErrors.SKILL_NOT_FOUND,
      });
    }

    const rendered = await skillsMgr.renderSkill(
      skill,
      this.kernel.getWorkdir()
    );
    const parts: string[] = [`[Skill activated: ${skill.name}]`];
    if (skill.allowedTools.length > 0) {
      parts.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
    }
    if (rendered) parts.push(rendered);
    if (params.arguments) parts.push(`User arguments: ${params.arguments}`);

    return this.sessionSend(connectionId, {
      text: parts.join("\n\n"),
      channel: params.channel,
      peerId: params.peerId,
      sessionKey: params.sessionKey,
    });
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Memory
  // ═══════════════════════════════════════════════════════

  private async memorySearch(params: { query: string; scope?: string }) {
    if (!params.query) {
      throw Object.assign(new Error("query is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    return this.doMemorySearch(params.query, params.scope);
  }

  private async doMemorySearch(
    query: string,
    scope?: string
  ): Promise<{ results: string[] }> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const workspace = this.kernel.getWorkspace();
    const projectWorkspace = this.kernel.getProjectWorkspace();
    const queryLower = query.toLowerCase();
    const matches: string[] = [];

    const dirsToSearch: string[] = [];
    const filesToSearch: string[] = [];

    if (scope === "all" || scope === "global" || !scope) {
      filesToSearch.push(path.join(workspace, "MEMORY.md"));
      dirsToSearch.push(path.join(workspace, "memory", "daily"));
    }
    if (scope === "all" || scope === "project" || !scope) {
      filesToSearch.push(path.join(projectWorkspace, "MEMORY.md"));
      dirsToSearch.push(path.join(projectWorkspace, "memory", "daily"));
    }

    for (const memPath of filesToSearch) {
      try {
        const text = (await fs.readFile(memPath, "utf-8")).trim();
        for (const para of text.split("\n\n")) {
          if (para.toLowerCase().includes(queryLower)) matches.push(para);
        }
      } catch {}
    }

    for (const dir of dirsToSearch) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files
          .filter((f) => f.endsWith(".jsonl"))
          .slice(-7)) {
          const content = await fs.readFile(path.join(dir, file), "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (
                entry.content &&
                entry.content.toLowerCase().includes(queryLower)
              )
                matches.push(entry.content);
            } catch {}
          }
        }
      } catch {}
    }

    return { results: matches.slice(0, 10) };
  }

  private async memoryWrite(params: {
    content: string;
    category?: string;
    scope?: string;
  }) {
    if (!params.content) {
      throw Object.assign(new Error("content is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const scope = params.scope || "project";
    const workspace = this.kernel.getWorkspace();
    const projectWorkspace = this.kernel.getProjectWorkspace();
    const memoryDir =
      scope === "global"
        ? path.join(workspace, "memory", "daily")
        : path.join(projectWorkspace, "memory", "daily");

    await fs.mkdir(memoryDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(memoryDir, `${today}.jsonl`);

    await fs.appendFile(
      filePath,
      JSON.stringify({
        ts: new Date().toISOString(),
        category: params.category || "general",
        content: params.content,
      }) + "\n",
      "utf-8"
    );

    return { ok: true, scope };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Config
  // ═══════════════════════════════════════════════════════

  private configGet() {
    const config = this.kernel.getConfig();
    const maskedProviders: Record<string, any> = {};
    for (const [name, provider] of Object.entries(config.providers)) {
      maskedProviders[name] = {
        ...provider,
        apiKey: provider.apiKey
          ? provider.apiKey.slice(0, 6) + "..." + provider.apiKey.slice(-4)
          : "(not set)",
      };
    }
    return { ...config, providers: maskedProviders };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Channel
  // ═══════════════════════════════════════════════════════

  private channelList() {
    const ephemeralChannels = this.kernel.getEphemeralChannels();
    const config = this.kernel.getConfig();
    const channels: Record<string, any> = {};
    for (const [id, cfg] of Object.entries(config.channels)) {
      channels[id] = {
        ...cfg,
        ephemeral: ephemeralChannels.has(id),
      };
    }
    return { channels };
  }

  private channelRegister(connectionId: string, params: { channel: string }) {
    if (!params.channel) {
      throw Object.assign(new Error("channel is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const client = this.clients.get(connectionId);
    if (client) {
      client.registeredChannels.add(params.channel);
      this.registerAskUserHandlerForChannel(params.channel);
      return { ok: true, channel: params.channel };
    }
    return { ok: false };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Cron
  // ═══════════════════════════════════════════════════════

  private cronList() {
    const cron: any = this.kernel.tryConsume("cron");
    if (!cron) return { jobs: [] };
    return {
      jobs: cron.jobs.map((j: any) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        scheduleKind: j.scheduleKind,
        nextRunAt: j.nextRunAt
          ? new Date(j.nextRunAt * 1000).toISOString()
          : null,
        consecutiveErrors: j.consecutiveErrors,
      })),
    };
  }

  private async cronTrigger(params: { id: string }) {
    if (!params.id) {
      throw Object.assign(new Error("id is required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const cron: any = this.kernel.tryConsume("cron");
    if (!cron) {
      throw Object.assign(new Error("Cron system not available"), {
        code: CustomErrors.KERNEL_NOT_READY,
      });
    }
    const job = cron.jobs.find((j: any) => j.id === params.id);
    if (!job) {
      throw Object.assign(new Error(`Cron job '${params.id}' not found`), {
        code: CustomErrors.PROCESSING_ERROR,
      });
    }
    if (!job.enabled) {
      return { ok: false, reason: "job_disabled" };
    }
    if (job.payload?.kind === "agent_turn" && job.payload.message) {
      const msg: InboundMessage = {
        text: job.payload.message,
        senderId: "cron",
        channel: "background",
        accountId: "internal",
        peerId: `cron:${job.id}`,
        isGroup: false,
        media: [],
        raw: {},
      };
      this.kernel.dispatchBackgroundMessage(msg);
      return { ok: true };
    }
    return { ok: false, reason: "no_agent_turn_payload" };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — Heartbeat
  // ═══════════════════════════════════════════════════════

  private heartbeatStatus() {
    const hb: any = this.kernel.tryConsume("heartbeat");
    return { running: !!hb };
  }

  private heartbeatTrigger() {
    const hb: any = this.kernel.tryConsume("heartbeat");
    if (!hb) {
      throw Object.assign(new Error("Heartbeat system not available"), {
        code: CustomErrors.KERNEL_NOT_READY,
      });
    }
    hb.trigger(this.kernel);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════
  //  METHOD HANDLERS — AskUser
  // ═══════════════════════════════════════════════════════

  private askUserAnswer(params: { questionId: string; answer: string }) {
    const { questionId, answer } = params;
    if (!questionId || answer === undefined || answer === null) {
      throw Object.assign(new Error("questionId and answer are required"), {
        code: StandardErrors.INVALID_PARAMS,
      });
    }
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      throw Object.assign(
        new Error(`Question '${questionId}' not found or expired`),
        { code: CustomErrors.QUESTION_NOT_FOUND }
      );
    }
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(questionId);
    pending.resolve(answer);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════
  //  Hook Registration — Push Notifications
  // ═══════════════════════════════════════════════════════

  private registerHooks() {
    this.kernel.on("llm:before", async (ctx, payload) => {
      const sk = payload?.sessionKey;
      if (!sk) return false;
      this.pushToSessionSubscribers(sk, "session.thinking", {
        sessionKey: sk,
      });
      return false;
    });

    this.kernel.on("tool:before", async (ctx, payload) => {
      const sk = payload?.sessionKey;
      if (!sk) return false;
      this.pushToSessionSubscribers(sk, "session.tool_call", {
        sessionKey: sk,
        tool: payload?.tool?.function?.name,
        args: payload?.args,
      });
      return false;
    });

    this.kernel.on("tool:after", async (ctx, payload) => {
      const sk = payload?.sessionKey;
      if (!sk) return false;
      this.pushToSessionSubscribers(sk, "session.tool_result", {
        sessionKey: sk,
        tool: payload?.tool?.function?.name,
        result: payload?.result?.slice(0, 2000),
      });
      return false;
    });

    this.kernel.on("message:sent", async (ctx, payload) => {
      const sk = payload?.sessionKey;
      const response = payload?.response || "";
      const req = sk ? this.sessionRequests.get(sk) : undefined;

      if (sk) {
        this.pushToSessionSubscribers(sk, "session.completed", {
          sessionKey: sk,
          requestId: req?.requestId || null,
          response,
        });
        if (req) this.sessionRequests.delete(sk);
      }
      return false;
    });

    this.kernel.on("llm:error", async (ctx, payload) => {
      const sk = payload?.sessionKey;
      if (!sk) return false;
      this.pushToSessionSubscribers(sk, "session.error", {
        sessionKey: sk,
        error: { message: String(payload?.err?.message || "Unknown error") },
      });
      return false;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  AskUser Handler Registration
  // ═══════════════════════════════════════════════════════

  private registerAskUserHandlers() {
    this.registerAskUserHandlerForChannel("gateway");
  }

  private registerAskUserHandlerForChannel(channel: string) {
    const handler: AskUserHandler = async (
      question,
      options,
      allowOther,
      context
    ) => {
      const questionId = this.generateId();

      const targetConnection = this.findConnectionForPeer(context.peerId);

      const payload: Record<string, any> = {
        questionId,
        question,
        options,
        allowOther,
        context: {
          channel: context.channel,
          peerId: context.peerId,
          senderId: context.senderId,
        },
      };

      if (targetConnection) {
        this.pushNotification(
          targetConnection.id,
          "ask_user.question",
          payload
        );
      } else {
        this.broadcastToChannel(channel, "ask_user.question", payload);
      }

      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingQuestions.delete(questionId);
          resolve("[User did not respond within the time limit.]");
        }, 300_000);

        this.pendingQuestions.set(questionId, {
          questionId,
          resolve,
          timer,
          connectionId: targetConnection?.id || "",
        });
      });
    };

    this.kernel.registerAskUserHandler(channel, handler);
  }

  private findConnectionForPeer(peerId: string): ClientConnection | undefined {
    for (const [, client] of this.clients) {
      if (client.metadata.peerId === peerId) return client;
    }
    return undefined;
  }

  // ═══════════════════════════════════════════════════════
  //  Notification Helpers
  // ═══════════════════════════════════════════════════════

  private pushToSessionSubscribers(
    sessionKey: string,
    method: string,
    params: Record<string, any>
  ) {
    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionKey)) {
        this.sendNotification(client.ws, method, params);
      }
    }
  }

  private pushNotification(
    connectionId: string,
    method: string,
    params: Record<string, any>
  ) {
    const client = this.clients.get(connectionId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      this.sendNotification(client.ws, method, params);
    }
  }

  private broadcastToChannel(
    channel: string,
    method: string,
    params: Record<string, any>
  ) {
    for (const [, client] of this.clients) {
      if (
        client.registeredChannels.has(channel) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        this.sendNotification(client.ws, method, params);
      }
    }
  }

  private sendNotification(
    ws: WebSocket,
    method: string,
    params: Record<string, any>
  ) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(makeNotification(method, params)));
    } catch {}
  }

  private sendToSocket(ws: WebSocket, msg: any) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  // ── Utilities ──────────────────────────────────────────

  private generateId(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
}
