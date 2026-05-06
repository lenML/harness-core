import type { CoreContext, AgentPlugin } from "../../types";
import { JsonRpcGatewayServer } from "../../gateway/json-rpc-server";

export class GatewayPlugin implements AgentPlugin {
  name = "gateway";
  async install(ctx: CoreContext) {
    const config = ctx.getConfig();
    const port = config.defaults.gatewayPort || 8765;
    const gw = new JsonRpcGatewayServer(ctx, port);
    ctx.provide("gateway", gw);

    ctx.on("llm:chunk", async (ctx, payload) => {
      gw.handleStreamChunk(payload);
      return false;
    });

    // Broadcast lifecycle notifications with the gateway's processingId
    // so the frontend can correlate them with the `send` response.
    ctx.on("session.processing_started", async (ctx, payload) => {
      const gwProcessingId = gw.getProcessingId(payload.sessionKey);
      gw.broadcastNotification("session.processing_started", {
        ...payload,
        processingId: gwProcessingId || payload.processingId,
      });
      return false;
    });

    ctx.on("session.processing_completed", async (ctx, payload) => {
      const gwProcessingId = gw.getProcessingId(payload.sessionKey);
      gw.broadcastNotification("session.processing_completed", {
        ...payload,
        processingId: gwProcessingId || payload.processingId,
      });
      return false;
    });

    ctx.on("startup", async () => {
      await gw.start();
    });

    ctx.on("shutdown", async () => {
      await gw.stop();
    });
  }
}
