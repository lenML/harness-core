import path from "node:path";
import fs from "node:fs";
import cronParser from "cron-parser";
import type { CoreContext, AgentPlugin, InboundMessage } from "../../types";

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: string;
  scheduleConfig: any;
  payload?: any;
  nextRunAt: number;
  consecutiveErrors: number;
}

class CronService {
  jobs: CronJob[] = [];
  private cronFile: string;
  private running = false;

  constructor(workspace: string) {
    this.cronFile = path.join(workspace, "CRON.json");
    this.loadJobs();
  }

  private loadJobs() {
    if (!fs.existsSync(this.cronFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cronFile, "utf-8"));
      for (const jd of raw.jobs || []) {
        if (!["at", "every", "cron"].includes(jd.schedule?.kind)) continue;
        const job: CronJob = {
          id: jd.id,
          name: jd.name,
          enabled: jd.enabled !== false,
          scheduleKind: jd.schedule.kind,
          scheduleConfig: jd.schedule,
          nextRunAt: 0,
          consecutiveErrors: 0,
        };
        // 加载时就计算好首次运行时间，不会立即触发
        this.calculateInitialNextRun(job);
        this.jobs.push(job);
      }
    } catch {}
  }

  /** 加载时计算首次运行时间 */
  private calculateInitialNextRun(job: CronJob): void {
    const now = Date.now() / 1000;

    if (job.scheduleKind === "every") {
      job.nextRunAt = now + (job.scheduleConfig.every_seconds || 3600);
    } else if (job.scheduleKind === "cron") {
      try {
        job.nextRunAt =
          cronParser.parse(job.scheduleConfig.expr).next().getTime() / 1000;
      } catch {
        job.enabled = false;
      }
    } else if (job.scheduleKind === "at") {
      job.nextRunAt = new Date(job.scheduleConfig.at).getTime() / 1000;
      if (now >= job.nextRunAt) {
        job.enabled = false;
      }
    }
  }

  /** 触发后推进到下次运行时间 */
  private advanceNextRun(job: CronJob): void {
    if (job.scheduleKind === "every") {
      job.nextRunAt =
        Date.now() / 1000 + (job.scheduleConfig.every_seconds || 3600);
    } else if (job.scheduleKind === "cron") {
      try {
        // 以上次计划时间为基准 +1s，确保拿到的是「再下一次」而非同一次
        const startDate = new Date(job.nextRunAt * 1000 + 1000);
        job.nextRunAt =
          cronParser
            .parse(job.scheduleConfig.expr, { currentDate: startDate })
            .next()
            .getTime() / 1000;
      } catch {
        job.enabled = false;
      }
    } else if (job.scheduleKind === "at") {
      // 一次性任务，触发后直接禁用
      job.enabled = false;
    }
  }

  start(ctx: CoreContext) {
    this.running = true;
    this.tickLoop(ctx);
  }

  stop() {
    this.running = false;
  }

  private async tickLoop(ctx: CoreContext) {
    while (this.running) {
      const now = Date.now() / 1000;
      for (const job of this.jobs) {
        if (!job.enabled) continue;
        // nextRunAt 未设置 或 还没到时间 → 跳过
        if (job.nextRunAt <= 0 || now < job.nextRunAt) continue;

        // ✅ 先推进到下次运行时间，防止派发期间重复触发
        this.advanceNextRun(job);

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
          ctx.dispatchBackgroundMessage(msg);
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export class CronPlugin implements AgentPlugin {
  name = "cron";
  async install(ctx: CoreContext) {
    const cron = new CronService(ctx.getWorkspace());
    ctx.provide("cron", cron);
    ctx.on("startup", async () => cron.start(ctx));
    ctx.on("shutdown", async () => cron.stop());
  }
}
