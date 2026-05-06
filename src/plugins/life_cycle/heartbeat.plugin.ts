import type { CoreContext, AgentPlugin, InboundMessage } from "../../types";

export class HeartbeatPlugin implements AgentPlugin {
  name = "heartbeat";
  private intervalId?: NodeJS.Timeout;
  private intervalMs?: number;

  /** Optional override; if omitted the value is read from config.defaults.heartbeatIntervalSeconds */
  constructor(intervalSeconds?: number) {
    if (intervalSeconds) this.intervalMs = intervalSeconds * 1000;
  }

  async install(ctx: CoreContext) {
    ctx.provide("heartbeat", this);

    ctx.on("startup", async () => {
      const config = ctx.getConfig();
      const seconds =
        this.intervalMs !== undefined
          ? this.intervalMs / 1000
          : config.defaults.heartbeatIntervalSeconds || 1800;
      this.intervalMs = seconds * 1000;

      this.intervalId = setInterval(() => {
        const msg: InboundMessage = {
          text: "[System Heartbeat] Check for tasks.",
          senderId: "system",
          channel: "background",
          accountId: "internal",
          peerId: "heartbeat-daemon",
          isGroup: false,
          media: [],
          raw: {},
        };
        ctx.dispatchBackgroundMessage(msg);
      }, this.intervalMs);
    });

    ctx.on("shutdown", async () => {
      if (this.intervalId) clearInterval(this.intervalId);
    });
  }

  trigger(ctx: CoreContext) {
    const msg: InboundMessage = {
      text: "[Manual Heartbeat Trigger]",
      senderId: "system",
      channel: "background",
      accountId: "internal",
      peerId: "heartbeat-daemon",
      isGroup: false,
      media: [],
      raw: {},
    };
    ctx.dispatchBackgroundMessage(msg);
  }
}
