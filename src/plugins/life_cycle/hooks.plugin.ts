import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CoreContext, AgentPlugin, HookConfigEntry } from "../../types";

const execPromise = promisify(exec);

export class HooksPlugin implements AgentPlugin {
  name = "hooks";
  async install(ctx: CoreContext) {
    const hooksPath = path.join(ctx.getProjectWorkspace(), "hooks.json");
    if (!fs.existsSync(hooksPath)) return;

    let entries: HookConfigEntry[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      entries = Array.isArray(raw) ? raw : raw.hooks || [];
    } catch (err: any) {
      console.error(`[HooksPlugin] Failed to parse hooks.json: ${err.message}`);
      return;
    }

    if (!entries.length) return;

    for (const entry of entries) {
      if (!entry.event || !entry.command) continue;

      const handler = async (hookCtx: CoreContext, payload?: any) => {
        try {
          // Inject payload as env vars for the command
          const env: Record<string, string> = {
            ...process.env,
            HOOK_EVENT: entry.event,
            HOOK_WORKDIR: ctx.getWorkdir(),
            HOOK_WORKSPACE: ctx.getWorkspace(),
          };
          if (payload) {
            env.HOOK_PAYLOAD = JSON.stringify(payload);
          }

          const { stdout, stderr } = await execPromise(entry.command, {
            cwd: ctx.getWorkdir(),
            timeout: 30000,
            env,
          });

          const output = (stdout || stderr || "").trim();

          if (!entry.silent && output) {
            console.log(`[Hook:${entry.event}] ${output}`);
          }

          // If injectTo is specified, we store the output for prompt injection
          if (entry.injectTo === "system_hint" && output) {
            const hookHints =
              ctx.tryConsume<Map<string, string>>("hookHints") ||
              new Map<string, string>();
            hookHints.set(entry.event, output);
            ctx.provide("hookHints", hookHints);
          }
        } catch (err: any) {
          if (!entry.silent) {
            console.error(
              `[Hook:${entry.event}] Command failed: ${err.message}`
            );
          }
        }
        return false; // Don't break the hook chain
      };

      ctx.on(entry.event as any, handler);
    }

    console.log(
      `[HooksPlugin] Registered ${entries.length} hook(s) from .harness/hooks.json`
    );
  }
}
