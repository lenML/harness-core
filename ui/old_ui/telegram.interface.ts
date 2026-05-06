import crypto from "node:crypto";
import type { AgentKernel } from "../../src/kernel";
import type { InboundMessage, AskUserHandler } from "../../src/types";

interface PendingQuestion {
  questionId: string;
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
  options: string[];
  allowOther: boolean;
  chatId: string;
  messageId: number;
  waitingForCustomInput: boolean;
}

export class TelegramInterface {
  private kernel: AgentKernel;
  private baseUrl: string;
  private allowedChats: Set<string>;
  private offset = 0;
  private seen = new Set<number>();
  private pollingActive = false;
  static MAX_MSG_LEN = 4096;

  private pendingQuestions = new Map<string, PendingQuestion>();

  constructor(kernel: AgentKernel, token: string, allowedChats: string[] = []) {
    this.kernel = kernel;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.allowedChats = new Set(allowedChats);
  }

  async start() {
    this.registerAskUserHandler();
    this.pollingActive = true;
    this.pollLoop();
    console.log("[Telegram] Polling started...");
  }

  async stop() {
    this.pollingActive = false;
  }

  // ──────────────────────────────────────────────────────────
  //  AskUser – Inline Keyboard based for Telegram
  // ──────────────────────────────────────────────────────────

  private registerAskUserHandler() {
    const handler: AskUserHandler = async (
      question,
      options,
      allowOther,
      context
    ) => {
      const questionId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

      const buttons = options.map((opt, idx) => [
        {
          text: opt,
          callback_data: `ask:${questionId}:${idx}`,
        },
      ]);

      if (allowOther) {
        buttons.push([
          {
            text: "✏️ Type your own answer",
            callback_data: `ask:${questionId}:custom`,
          },
        ]);
      }

      const sent = await this.api("sendMessage", {
        chat_id: context.peerId,
        text: `❓ *Question*\n\n${question}`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });

      return new Promise<string>((resolve) => {
        const timer = setTimeout(async () => {
          this.pendingQuestions.delete(questionId);
          resolve("[User did not respond within the time limit.]");
          // Remove inline keyboard on timeout
          if (sent?.message_id) {
            await this.api("editMessageReplyMarkup", {
              chat_id: context.peerId,
              message_id: sent.message_id,
              reply_markup: { inline_keyboard: [] },
            });
          }
        }, 300_000); // 5 min

        this.pendingQuestions.set(questionId, {
          questionId,
          resolve,
          timer,
          options,
          allowOther,
          chatId: context.peerId,
          messageId: sent?.message_id,
          waitingForCustomInput: false,
        });
      });
    };

    this.kernel.registerAskUserHandler("telegram", handler);
  }

  // ──────────────────────────────────────────────────────────
  //  Polling
  // ──────────────────────────────────────────────────────────

  private async pollLoop() {
    while (this.pollingActive) {
      try {
        const result = await this.api("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });
        if (Array.isArray(result)) {
          for (const update of result) {
            const uid = update.update_id || 0;
            if (uid >= this.offset) this.offset = uid + 1;
            if (this.seen.has(uid)) continue;
            this.seen.add(uid);
            if (this.seen.size > 5000) this.seen.clear();

            if (update.callback_query) {
              this.handleCallbackQuery(update.callback_query);
              continue;
            }

            const msg = update.message;
            if (!msg) continue;
            const inbound = this.parse(msg);
            if (!inbound) continue;

            // Check if this peer is currently waiting to type a custom answer
            const customPending = this.findCustomPendingForPeer(inbound.peerId);
            if (customPending) {
              clearTimeout(customPending.timer);
              this.pendingQuestions.delete(customPending.questionId);
              customPending.resolve(inbound.text.trim());
              await this.removeInlineKeyboard(
                customPending.chatId,
                customPending.messageId
              );
              continue;
            }

            if (
              this.allowedChats.size > 0 &&
              !this.allowedChats.has(inbound.peerId)
            )
              continue;

            this.processIncomingMessage(inbound);
          }
        }
      } catch (err: any) {
        console.error(`[Telegram] Poll error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async handleCallbackQuery(cb: any) {
    const data = cb.data || "";
    const chatId = String(cb.message?.chat?.id || "");
    const peerId = chatId; // For private chats, peerId == chatId
    const fromId = String(cb.from?.id || "");

    if (!data.startsWith("ask:")) return;

    const [, questionId, choice] = data.split(":");
    const pending = this.pendingQuestions.get(questionId);

    if (!pending || pending.chatId !== chatId) return;

    // Acknowledge the button press
    await this.api("answerCallbackQuery", {
      callback_query_id: cb.id,
    });

    clearTimeout(pending.timer);

    if (choice === "custom") {
      // Ask the user to type their answer
      pending.waitingForCustomInput = true;
      await this.api("sendMessage", {
        chat_id: chatId,
        text: "Please type your answer:",
      });
      // Reset timeout for typing
      pending.timer = setTimeout(async () => {
        this.pendingQuestions.delete(questionId);
        pending.resolve("[User did not respond within the time limit.]");
        await this.removeInlineKeyboard(chatId, pending.messageId);
      }, 300_000);
      return;
    }

    // Normal option selected
    const idx = parseInt(choice, 10);
    const selected = pending.options[idx] || "[Invalid selection]";

    this.pendingQuestions.delete(questionId);
    pending.resolve(selected);

    await this.removeInlineKeyboard(chatId, pending.messageId);
  }

  private findCustomPendingForPeer(
    peerId: string
  ): PendingQuestion | undefined {
    for (const [, pq] of this.pendingQuestions) {
      if (pq.chatId === peerId && pq.waitingForCustomInput) return pq;
    }
    return undefined;
  }

  private async removeInlineKeyboard(chatId: string, messageId: number) {
    if (!messageId) return;
    try {
      await this.api("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {}
  }

  // ──────────────────────────────────────────────────────────
  //  Message processing with Interruption Support
  // ──────────────────────────────────────────────────────────

  /**
   * Process incoming messages. If the kernel is currently processing for this session,
   * we enqueue the message as an interrupt. Otherwise, we start a new processing cycle.
   */
  private processIncomingMessage(inbound: InboundMessage) {
    const { sessionKey } = this.kernel.resolveRouting(inbound);

    if (this.kernel.isSessionProcessing(sessionKey)) {
      console.log(`[Telegram] Enqueued interrupt for ${sessionKey}`);
      this.kernel.enqueueUserMessage(inbound);
    } else {
      // Not processing, start processing
      this.kernel
        .handleMessage(inbound)
        .then((response) => {
          if (response) this.send(inbound.peerId, response);
        })
        .catch((err) => {
          console.error(`[Telegram] Error handling message: ${err.message}`);
        });
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Message parsing & sending
  // ──────────────────────────────────────────────────────────

  private parse(msg: any): InboundMessage | null {
    const chat = msg.chat || {};
    const chatType = chat.type || "";
    const chatId = String(chat.id || "");
    const userId = String(msg.from?.id || "");
    const text = msg.text || msg.caption || "";
    if (!text) return null;
    const isGroup = chatType === "group" || chatType === "supergroup";
    let peerId: string;
    if (chatType === "private") peerId = userId;
    else if (isGroup && chat.is_forum && msg.message_thread_id != null)
      peerId = `${chatId}:topic:${msg.message_thread_id}`;
    else peerId = chatId;
    return {
      text,
      senderId: userId,
      channel: "telegram",
      accountId: "tg-primary",
      peerId,
      isGroup,
      media: [],
      raw: {},
    };
  }

  async send(to: string, text: string): Promise<boolean> {
    let chatId = to,
      threadId: number | undefined;
    if (to.includes(":topic:")) {
      const parts = to.split(":topic:");
      chatId = parts[0];
      threadId = parts[1] ? parseInt(parts[1], 10) : undefined;
    }
    let ok = true;
    for (const chunk of this.chunk(text)) {
      const res = await this.api("sendMessage", {
        chat_id: chatId,
        text: chunk,
        message_thread_id: threadId,
      });
      if (!res || !Object.keys(res).length) ok = false;
    }
    return ok;
  }

  private async api(
    method: string,
    params: Record<string, any> = {}
  ): Promise<any> {
    const filtered = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v != null)
    );
    try {
      const resp = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filtered),
      });
      const data = await resp.json();
      if (!data.ok) return {};
      return data.result || {};
    } catch {
      return {};
    }
  }

  private chunk(text: string): string[] {
    if (text.length <= TelegramInterface.MAX_MSG_LEN) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= TelegramInterface.MAX_MSG_LEN) {
        chunks.push(remaining);
        break;
      }
      let cut = remaining.lastIndexOf("\n", TelegramInterface.MAX_MSG_LEN);
      if (cut <= 0) cut = TelegramInterface.MAX_MSG_LEN;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^\n+/, "");
    }
    return chunks;
  }
}
