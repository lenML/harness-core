import type { StreamBufferConfig, StreamChunk } from "../types";

interface BufferEntry {
  processingId: string;
  content: string;
  toolCallDeltas: any[];
  timer: NodeJS.Timeout | null;
}

export type StreamBufferFlushCallback = (
  sessionKey: string,
  processingId: string,
  data: {
    delta: string | null;
    toolCallDeltas: any[] | null;
    finishReason: string | null;
  }
) => void;

export const DEFAULT_STREAM_BUFFER_CONFIG: StreamBufferConfig = {
  enabled: true,
  flushIntervalMs: 100,
  flushOnNewline: true,
};

/**
 * Buffers streaming chunks to reduce RPC notification frequency.
 *
 * Flush triggers:
 *  1. Timer — accumulated content is sent at least every `flushIntervalMs` ms
 *  2. Newline — when `flushOnNewline` is true and content contains `\n`
 *  3. Finish  — `finishReason` always flushes immediately
 *
 * When `enabled` is false, every chunk is passed through without buffering.
 */
export class StreamBuffer {
  private buffers = new Map<string, BufferEntry>();
  private config: StreamBufferConfig;
  private onFlush: StreamBufferFlushCallback;

  constructor(config: StreamBufferConfig, onFlush: StreamBufferFlushCallback) {
    this.config = { ...DEFAULT_STREAM_BUFFER_CONFIG, ...config };
    this.onFlush = onFlush;
  }

  get currentConfig(): Readonly<StreamBufferConfig> {
    return { ...this.config };
  }

  updateConfig(patch: Partial<StreamBufferConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  push(sessionKey: string, processingId: string, chunk: StreamChunk): void {
    if (!this.config.enabled) {
      this.onFlush(sessionKey, processingId, {
        delta: chunk.content || null,
        toolCallDeltas: chunk.toolCallDeltas || null,
        finishReason: chunk.finishReason || null,
      });
      return;
    }

    // Finish reason: flush buffered content first, then emit finish
    if (chunk.finishReason) {
      this.flushBuffer(sessionKey);
      this.onFlush(sessionKey, processingId, {
        delta: null,
        toolCallDeltas: null,
        finishReason: chunk.finishReason,
      });
      return;
    }

    // Check for newline in the incoming content
    const hasNewline =
      this.config.flushOnNewline && (chunk.content?.includes("\n") ?? false);

    // Get or create buffer entry
    let entry = this.buffers.get(sessionKey);
    if (!entry) {
      entry = { processingId, content: "", toolCallDeltas: [], timer: null };
      this.buffers.set(sessionKey, entry);
    }

    // Accumulate content and tool call deltas
    if (chunk.content) entry.content += chunk.content;
    if (chunk.toolCallDeltas && chunk.toolCallDeltas.length > 0) {
      entry.toolCallDeltas.push(...chunk.toolCallDeltas);
    }

    // Flush on newline
    if (hasNewline) {
      this.flushBuffer(sessionKey);
      return;
    }

    // Start timer if not already running
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        this.flushBuffer(sessionKey);
      }, this.config.flushIntervalMs);
    }
  }

  /** Flush the buffer for a session, sending accumulated content via the callback. */
  flushBuffer(sessionKey: string): void {
    const entry = this.buffers.get(sessionKey);
    if (!entry) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (entry.content || entry.toolCallDeltas.length > 0) {
      this.onFlush(sessionKey, entry.processingId, {
        delta: entry.content || null,
        toolCallDeltas:
          entry.toolCallDeltas.length > 0 ? entry.toolCallDeltas : null,
        finishReason: null,
      });
    }

    this.buffers.delete(sessionKey);
  }

  /** Discard buffered content without sending. Useful on disconnect / error. */
  clear(sessionKey?: string): void {
    if (sessionKey) {
      const entry = this.buffers.get(sessionKey);
      if (entry?.timer) clearTimeout(entry.timer);
      this.buffers.delete(sessionKey);
    } else {
      for (const [, entry] of this.buffers) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      this.buffers.clear();
    }
  }

  hasBuffer(sessionKey: string): boolean {
    return this.buffers.has(sessionKey);
  }

  /**
   * Get the current buffered content for a session without flushing.
   * Returns empty string if no buffer exists.
   */
  getBufferContent(sessionKey: string): string {
    const entry = this.buffers.get(sessionKey);
    if (!entry) return "";
    return entry.content;
  }
}
