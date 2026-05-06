import * as dotenv from "dotenv";
import * as path from "node:path";
import { AgentKernel } from "./kernel";
import { CoreAbilitiesPlugin } from "./plugins/core/core-abilities.plugin";
import { RoutingPlugin } from "./plugins/core/routing.plugin";
import { SessionPlugin } from "./plugins/core/session.plugin";
import { PromptBuilderPlugin } from "./plugins/core/prompt-builder.plugin";
import { BasicToolsPlugin } from "./plugins/tools/basic-tools.plugin";
import { MemoryToolsPlugin } from "./plugins/tools/memory-tools.plugin";
import { SkillsPlugin } from "./plugins/core/skills.plugin";
import { CronPlugin } from "./plugins/life_cycle/cron.plugin";
import { GatewayPlugin } from "./plugins/core/gateway.plugin";
import { HeartbeatPlugin } from "./plugins/life_cycle/heartbeat.plugin";
import { WebFetchPlugin } from "./plugins/tools/webfetch/webfetch.plugin";
import { HooksPlugin } from "./plugins/life_cycle/hooks.plugin";
import { ContextGuardPlugin } from "./plugins/core/context-guard.plugin";
import { AgentToolPlugin } from "./plugins/tools/agent-tool.plugin";
import { AskUserPlugin } from "./plugins/tools/ask-user.plugin";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

async function main() {
  const kernel = new AgentKernel();

  // Core & Routing & Session
  await kernel.use(new CoreAbilitiesPlugin());
  await kernel.use(new RoutingPlugin());
  await kernel.use(new SessionPlugin());
  await kernel.use(new PromptBuilderPlugin());

  // Context Guard
  await kernel.use(new ContextGuardPlugin());

  // Tools & Memory & Skills
  await kernel.use(new BasicToolsPlugin());
  await kernel.use(new MemoryToolsPlugin());
  await kernel.use(new SkillsPlugin());
  await kernel.use(new WebFetchPlugin());
  await kernel.use(new AgentToolPlugin());
  await kernel.use(new AskUserPlugin());

  // Proactive & Gateway
  await kernel.use(new CronPlugin());
  await kernel.use(new GatewayPlugin());
  await kernel.use(new HeartbeatPlugin());

  // Hooks
  await kernel.use(new HooksPlugin());

  await kernel.start();

  console.log("[Daemon] Gateway is running. Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\n[Daemon] Shutting down...");
    await kernel.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error starting application:", err);
  process.exit(1);
});
