import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CoreContext,
  InboundMessage,
  StreamChunk,
  StreamBufferConfig,
} from "../types";
import { StreamBuffer, DEFAULT_STREAM_BUFFER_CONFIG } from "./stream-buffer";

interface ClientConnection {
  ws: WebSocket;
  channels: Set<string>;
}

interface PendingAsk {
  questionId: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

interface ProcessingInfo {
  processingId: string;
  ws: WebSocket;
}

let _seq = 0;
function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${(++_seq).toString(36)}`;
}

export class JsonRpcGatewayServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private clients = new Map<WebSocket, ClientConnection>();
  private pendingAsks = new Map<string, PendingAsk>();
  private askUserChannels = new Set<string>();
  private processingMap = new Map<string, ProcessingInfo>();
  private streamBuffer: StreamBuffer;

  private port: number;
  private ctx: CoreContext;
  private authToken: string;

  constructor(ctx: CoreContext, port = 8765) {
    this.ctx = ctx;
    this.port = port;
    this.authToken = (ctx as any).authToken;

    const config = ctx.getConfig();
    const bufferConfig: StreamBufferConfig = {
      ...DEFAULT_STREAM_BUFFER_CONFIG,
      ...(config.defaults.streamBuffer || {}),
    };

    this.streamBuffer = new StreamBuffer(
      bufferConfig,
      (sessionKey, processingId, data) => {
        const info = this.processingMap.get(sessionKey);
        if (!info || info.ws.readyState !== WebSocket.OPEN) return;
        this.notify(info.ws, "stream_chunk", {
          processingId,
          sessionKey,
          ...data,
        });
      }
    );
  }

  async start(): Promise<void> {
    this.httpServer = createServer(async (req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", `http://localhost:${this.port}`);
      const token = url.searchParams.get("token");
      if (this.authToken && (!token || token !== this.authToken)) {
        try {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "auth_failed",
              params: { reason: "Invalid or missing token", code: 4001 },
            })
          );
        } catch {}
        ws.close(4001, "Unauthorized: Invalid or missing token");
        return;
      }

      const client: ClientConnection = { ws, channels: new Set() };
      this.clients.set(ws, client);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.dispatch(ws, msg);
        } catch (err: any) {
          this.replyError(ws, null, -32700, `Parse error: ${err.message}`);
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        for (const [sessionKey, info] of this.processingMap) {
          if (info.ws === ws) {
            this.streamBuffer.clear(sessionKey);
            this.processingMap.delete(sessionKey);
          }
        }
      });

      this.notify(ws, "connected", { version: "1.0" });
    });

    this.httpServer.listen(this.port, () => {
      console.log(
        `[Gateway] HTTP + WS server listening on http://localhost:${this.port}`
      );
    });
  }

  async stop(): Promise<void> {
    this.streamBuffer.clear();
    if (this.wss) this.wss.close();
    if (this.httpServer) this.httpServer.close();
  }

  /**
   * Look up the gateway's processingId for a session.
   * Used by external hooks (e.g. GatewayPlugin) to correlate
   * session.processing_started / session.processing_completed
   * notifications with the processingId returned by `send`.
   */
  getProcessingId(sessionKey: string): string | undefined {
    return this.processingMap.get(sessionKey)?.processingId;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const token = url.searchParams.get("token");
    if (this.authToken && (!token || token !== this.authToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/upload") {
      await this.handleFileUpload(req, res);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  private async handleFileUpload(req: IncomingMessage, res: ServerResponse) {
    // 限制总请求体大小 (50 MB)
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    let size = 0;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_FILE_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File too large (max 50 MB)" }));
        return;
      }
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const contentType =
      req.headers["content-type"] || "application/octet-stream";
    const ext = contentType.split("/")[1] || "bin";
    const fileId = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const filename = req.headers["x-filename"]
      ? `${req.headers["x-filename"]}`
      : `${fileId}.${ext}`;

    const uploadDir = path.join(this.ctx.getWorkspace(), "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const filePath = path.join(uploadDir, fileId + "." + ext);
    try {
      await fs.promises.writeFile(filePath, buffer);
      const fileUrl = `ws://localhost:${this.port}/uploads/${fileId}.${ext}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fileId, url: fileUrl, filename }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  handleStreamChunk(payload: {
    sessionKey: string;
    channel: string;
    chunk: StreamChunk;
  }): void {
    const { sessionKey, chunk } = payload;
    const info = this.processingMap.get(sessionKey);
    if (!info) return;
    this.streamBuffer.push(sessionKey, info.processingId, chunk);
  }

  // Broadcast to all connected clients
  broadcastNotification(method: string, params: any): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const [, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  private async dispatch(ws: WebSocket, msg: any): Promise<void> {
    if (!msg || msg.jsonrpc !== "2.0")
      return this.replyError(ws, msg?.id, -32600, "Invalid Request");
    const { method, params = {}, id } = msg;
    try {
      const result = await this.handleMethod(ws, method, params);
      if (id !== undefined) this.replyResult(ws, id, result);
    } catch (err: any) {
      if (id !== undefined) this.replyError(ws, id, -32603, err.message);
    }
  }

  private async handleMethod(
    ws: WebSocket,
    method: string,
    params: any
  ): Promise<any> {
    switch (method) {
      case "ping":
        return { pong: true, timestamp: Date.now() };
      case "register": {
        const client = this.clients.get(ws)!;
        const channels: string[] = params.channels || [];
        for (const ch of channels) {
          client.channels.add(ch);
          this.ensureAskUserHandler(ch);
        }
        return { registered: true, channels: Array.from(client.channels) };
      }
      case "send":
        return this.methodSend(ws, params);
      case "enqueue":
        return this.methodEnqueue(params);
      case "askUserRespond":
        return this.methodAskUserRespond(params);

      // Model
      case "listModels":
        return this.ctx.listModels();
      case "switchModel":
        this.ctx.switchModel(params.key);
        return { activeModel: params.key };
      case "getCurrentModel":
        return {
          key: this.ctx.getCurrentModelKey(),
          config: this.ctx.getCurrentModelConfig(),
        };

      // Tools & Skills
      case "listTools":
        return this.ctx.getTools();
      case "listSkills": {
        const sm = this.ctx.tryConsume<any>("skills");
        return sm?.skills || [];
      }
      case "invokeSkill": {
        const sm = this.ctx.tryConsume<any>("skills");
        if (!sm) throw new Error("Skills plugin not loaded");
        const skill = sm.findByName(params.name);
        if (!skill) throw new Error(`Skill '${params.name}' not found`);
        const rendered = await sm.renderSkill(skill, this.ctx.getWorkdir());
        const parts = [`[Skill activated: ${skill.name}]`];
        if (skill.allowedTools.length > 0)
          parts.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
        if (rendered) parts.push(rendered);
        if (params.arguments) parts.push(`User arguments: ${params.arguments}`);
        return {
          content: parts.join("\n\n"),
          skill: {
            name: skill.name,
            invocation: skill.invocation,
            description: skill.description,
          },
        };
      }

      // Sessions
      case "listSessions":
        return this.methodListSessions();
      case "clearSession":
        this.ctx.getSessionStore().clear(params.key);
        return { cleared: true };
      case "compactSession": {
        const msgs = await this.ctx.getSessionStore().load(params.key);
        const mc = this.ctx.getCurrentModelConfig();
        const compacted = await this.ctx.getSessionStore().compact(msgs, mc);
        await this.ctx.getSessionStore().save(params.key, compacted);
        return { from: msgs.length, to: compacted.length };
      }
      case "getContext": {
        const msgs = await this.ctx.getSessionStore().load(params.key);
        const tokens = this.ctx.getSessionStore().estimateTokens(msgs);
        return { tokens, messages: msgs.length, sessionKey: params.key };
      }
      case "sessionHistory": {
        if (!params.key) throw new Error("key is required");
        const allMsgs = await this.ctx.getSessionStore().load(params.key);
        const tokens = this.ctx.getSessionStore().estimateTokens(allMsgs);
        const limit = params.limit && params.limit > 0 ? params.limit : 0;
        const beforeIndex =
          params.beforeIndex && params.beforeIndex >= 0
            ? params.beforeIndex
            : -1;
        let messages = allMsgs;
        if (beforeIndex >= 0) messages = allMsgs.slice(0, beforeIndex);
        if (limit > 0 && messages.length > limit)
          messages = messages.slice(-limit);
        return {
          sessionKey: params.key,
          messages,
          totalMessages: allMsgs.length,
          tokenEstimate: tokens,
        };
      }
      case "sessionInterrupt": {
        if (!params.sessionKey) throw new Error("sessionKey is required");
        const controller = this.ctx.getAbortController(params.sessionKey);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          return { ok: true, sessionKey: params.sessionKey };
        }
        return {
          ok: false,
          sessionKey: params.sessionKey,
          reason: "not_processing",
        };
      }
      case "session.create": {
        const result = this.ctx.createSession({
          channel: params.channel,
          peerId: params.peerId,
          agentId: params.agentId,
          ephemeral: params.ephemeral || false,
        });
        this.broadcastNotification("session.created", {
          sessionKey: result.sessionKey,
          forkedFrom: null,
          agentId: result.agentId,
        });
        return result;
      }
      case "session.delete": {
        if (!params.sessionKey) throw new Error("sessionKey is required");
        this.ctx.deleteSession(params.sessionKey);
        this.broadcastNotification("session.deleted", {
          sessionKey: params.sessionKey,
        });
        return { deleted: true };
      }
      case "regenerate": {
        if (!params.sessionKey) throw new Error("sessionKey is required");
        if (params.model) {
          try {
            this.ctx.switchModel(params.model);
          } catch {}
        }
        return this.methodRegenerate(ws, params.sessionKey);
      }

      // P1: Fork & Edit
      case "session.fork": {
        if (!params.sessionKey || !params.messageId)
          throw new Error("sessionKey and messageId are required");
        const newSessionKey = await this.ctx.forkSession(
          params.sessionKey,
          params.messageId
        );
        this.broadcastNotification("session.created", {
          sessionKey: newSessionKey,
          forkedFrom: params.sessionKey,
        });
        return { newSessionKey };
      }
      case "session.editMessage": {
        if (!params.sessionKey || !params.messageId || !params.newText)
          throw new Error("sessionKey, messageId, and newText are required");
        return this.methodEditMessage(
          ws,
          params.sessionKey,
          params.messageId,
          params.newText
        );
      }

      // P2: Config & Metadata
      case "config.update": {
        if (!params.path || params.value === undefined)
          throw new Error("path and value are required");
        this.ctx.updateConfig(params.path, params.value);
        return { updated: true, path: params.path };
      }
      case "session.updateMetadata": {
        if (!params.sessionKey || !params.metadata)
          throw new Error("sessionKey and metadata are required");
        this.ctx.updateSessionMetadata(params.sessionKey, params.metadata);
        return { updated: true };
      }

      // P1: Stats
      case "system.stats":
        return this.ctx.getStats();
      case "system.toolStats":
        return this.ctx.getToolStats();

      // Agents & Routing
      case "listAgents":
        return this.ctx.listAgents();
      case "listBindings": {
        const bt = this.ctx.tryConsume<any>("bindings");
        return bt?.listAll() || [];
      }
      case "resolveRoute": {
        const fakeMsg: InboundMessage = {
          text: "",
          senderId: "",
          channel: params.channel || "",
          accountId: params.accountId || "",
          peerId: params.peerId || "",
          isGroup: false,
          media: [],
          raw: {},
        };
        return this.ctx.resolveRouting(fakeMsg);
      }

      // System
      case "getConfig":
        return this.maskedConfig();
      case "getWorkdir":
        return {
          workdir: this.ctx.getWorkdir(),
          workspace: this.ctx.getWorkspace(),
          projectWorkspace: this.ctx.getProjectWorkspace(),
        };
      case "listChannels": {
        const ec = this.ctx.getEphemeralChannels();
        const cfg = this.ctx.getConfig();
        return Object.entries(cfg.channels).map(([id, c]) => ({
          id,
          ...c,
          ephemeral: ec.has(id),
        }));
      }

      // Proactive
      case "listCronJobs": {
        const cron = this.ctx.tryConsume<any>("cron");
        return cron?.jobs || [];
      }
      case "triggerCron": {
        const cron = this.ctx.tryConsume<any>("cron");
        if (!cron) throw new Error("Cron plugin not loaded");
        const job = cron.jobs.find((j: any) => j.id === params.id);
        if (!job) throw new Error(`Cron job '${params.id}' not found`);
        if (job.payload?.kind === "agent_turn" && job.payload.message) {
          this.ctx.dispatchBackgroundMessage({
            text: job.payload.message,
            senderId: "cron",
            channel: "background",
            accountId: "internal",
            peerId: `cron:${job.id}`,
            isGroup: false,
            media: [],
            raw: {},
          });
        }
        return { triggered: true };
      }
      case "triggerHeartbeat": {
        const hb = this.ctx.tryConsume<any>("heartbeat");
        if (!hb) throw new Error("Heartbeat plugin not loaded");
        hb.trigger(this.ctx);
        return { triggered: true };
      }
      case "isSessionProcessing":
        return { processing: this.ctx.isSessionProcessing(params.sessionKey) };

      // Stream Buffer
      case "streamBuffer.getConfig":
        return this.streamBuffer.currentConfig;
      case "streamBuffer.updateConfig": {
        if (params && typeof params === "object")
          this.streamBuffer.updateConfig(params);
        return this.streamBuffer.currentConfig;
      }

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  /**
   * Return config with API keys masked for safe display.
   */
  private maskedConfig(): any {
    const config = this.ctx.getConfig();
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

  /**
   * List sessions with guaranteed complete fields.
   */
  private methodListSessions(): any[] {
    const raw = this.ctx.getSessionStore().list();
    return raw.map((s) => ({
      key: s.key,
      messageCount: s.messageCount ?? 0,
      ephemeral: s.ephemeral ?? false,
      createdAt: s.createdAt ?? null,
      lastActiveAt: s.lastActiveAt ?? null,
      metadata: s.metadata ?? {},
    }));
  }

  /**
   * Send a message into a session.
   *
   * If `params.sessionKey` is provided the message is dispatched directly
   * to that session — no routing is performed.  This is the primary way
   * for front-end clients to target an existing conversation.
   *
   * If `sessionKey` is omitted the message is routed via the binding table
   * using `channel` / `peerId` (backward-compatible behaviour).
   */
  private methodSend(ws: WebSocket, params: any): any {
    const processingId = uid("p");
    const msg = this.toInboundMessage(params);

    let sessionKey: string;
    if (params.sessionKey) {
      // Explicit session — use it directly, bypass routing
      sessionKey = params.sessionKey;
    } else {
      // No session specified — route automatically
      const resolved = this.ctx.resolveRouting(msg);
      sessionKey = resolved.sessionKey;
    }

    const isProcessing = this.ctx.isSessionProcessing(sessionKey);

    if (isProcessing) {
      this.ctx.enqueueUserMessage(msg, sessionKey);
      return { processingId, sessionKey, queued: true };
    }

    this.processingMap.set(sessionKey, { processingId, ws });
    this.ctx
      .handleMessage(msg, sessionKey)
      .then((response) => {
        this.streamBuffer.flushBuffer(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", {
          processingId,
          sessionKey,
          response: response || undefined,
          queued: !response ? true : undefined,
        });
      })
      .catch((err) => {
        this.streamBuffer.clear(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", {
          processingId,
          sessionKey,
          error: err.message,
        });
      });

    return { processingId, sessionKey, processing: true };
  }

  private methodRegenerate(ws: WebSocket, sessionKey: string): any {
    const processingId = uid("p");
    this.processingMap.set(sessionKey, { processingId, ws });
    this.ctx
      .regenerateSession(sessionKey)
      .then((response) => {
        this.streamBuffer.flushBuffer(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", { processingId, sessionKey, response });
      })
      .catch((err) => {
        this.streamBuffer.clear(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", {
          processingId,
          sessionKey,
          error: err.message,
        });
      });
    return { processingId, sessionKey, processing: true };
  }

  private methodEditMessage(
    ws: WebSocket,
    sessionKey: string,
    messageId: string,
    newText: string
  ): any {
    const processingId = uid("p");
    this.processingMap.set(sessionKey, { processingId, ws });
    this.ctx
      .editSessionMessage(sessionKey, messageId, newText)
      .then((response) => {
        this.streamBuffer.flushBuffer(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", { processingId, sessionKey, response });
      })
      .catch((err) => {
        this.streamBuffer.clear(sessionKey);
        this.processingMap.delete(sessionKey);
        this.notify(ws, "response", {
          processingId,
          sessionKey,
          error: err.message,
        });
      });
    return { processingId, sessionKey, processing: true };
  }

  private methodEnqueue(params: any): any {
    const msg = this.toInboundMessage(params);
    let sessionKey: string;
    if (params.sessionKey) {
      sessionKey = params.sessionKey;
    } else {
      const resolved = this.ctx.resolveRouting(msg);
      sessionKey = resolved.sessionKey;
    }
    this.ctx.enqueueUserMessage(msg, sessionKey);
    return { queued: true, sessionKey };
  }

  private methodAskUserRespond(params: any): any {
    const { questionId, answer } = params;
    if (!questionId) throw new Error("questionId is required");
    const pending = this.pendingAsks.get(questionId);
    if (!pending) throw new Error(`No pending question '${questionId}'`);
    clearTimeout(pending.timer);
    this.pendingAsks.delete(questionId);
    pending.resolve(answer || "");
    return { accepted: true };
  }

  private ensureAskUserHandler(channel: string): void {
    if (this.askUserChannels.has(channel)) return;
    this.askUserChannels.add(channel);
    this.ctx.registerAskUserHandler(
      channel,
      async (question, options, allowOther, context) => {
        const questionId = uid("q");
        const client = this.findClientForChannel(channel);
        if (!client)
          return `[No client for channel '${channel}'. Answer in your next message.]`;
        return new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingAsks.delete(questionId);
            resolve("[User did not respond within the time limit.]");
          }, 300_000);
          this.pendingAsks.set(questionId, { questionId, resolve, timer });
          this.notify(client.ws, "ask_user", {
            questionId,
            question,
            options,
            allowOther,
            context,
          });
        });
      }
    );
  }

  private findClientForChannel(channel: string): ClientConnection | undefined {
    for (const [, c] of this.clients) {
      if (c.channels.has(channel) && c.ws.readyState === WebSocket.OPEN)
        return c;
    }
    for (const [, c] of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) return c;
    }
    return undefined;
  }

  private toInboundMessage(params: any): InboundMessage {
    return {
      text: params.text || "",
      senderId: params.senderId || "ws-client",
      channel: params.channel || "websocket",
      accountId: params.accountId || "ws",
      peerId: params.peerId || "ws-client",
      isGroup: params.isGroup || false,
      media: params.media || [],
      raw: params.raw || {},
    };
  }

  private replyResult(ws: WebSocket, id: any, result: any): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  private replyError(
    ws: WebSocket,
    id: any,
    code: number,
    message: string
  ): void {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
  private notify(ws: WebSocket, method: string, params: any): void {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }
}
