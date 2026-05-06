import * as readline from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import * as inquirer from "@inquirer/prompts";
import type { AgentKernel } from "../../src/kernel";
import type { InboundMessage, AskUserHandler } from "../../src/types";
import type { SkillsManager } from "../../src/skills/skills-manager";

export class CLIInterface {
  private kernel: AgentKernel;
  private forceAgent: string = "";
  private sessionLabel: string = "";

  constructor(kernel: AgentKernel) {
    this.kernel = kernel;
  }

  async start() {
    this.registerAskUserHandler();
    this.printBanner();
    this.promptLoop();
  }

  // ──────────────────────────────────────────────────────────
  //  AskUser – interactive inquirer-based handler for CLI
  // ──────────────────────────────────────────────────────────

  private registerAskUserHandler() {
    const handler: AskUserHandler = async (question, options, allowOther) => {
      const choices = [...options];
      if (allowOther) {
        choices.push("__OTHER__");
      }

      const selected = await inquirer.select({
        message: question,
        choices: choices.map((c) =>
          c === "__OTHER__" ? "✏️  Other (type your own)" : c
        ),
      });

      if (selected === "__OTHER__") {
        const custom = await inquirer.input({
          message: "Please provide your own answer:",
        });
        return custom || "(empty answer)";
      }

      return selected;
    };

    this.kernel.registerAskUserHandler("cli", handler);
  }

  // ──────────────────────────────────────────────────────────
  //  Prompt loop (Non-blocking, supports interjecting)
  // ──────────────────────────────────────────────────────────

  private getPeerId(): string {
    const base = this.sessionLabel
      ? `cli-user:${this.sessionLabel}`
      : "cli-user";
    return this.forceAgent ? `agent:${this.forceAgent}:${base}` : base;
  }

  private getSessionKey(): string {
    const agentId = this.forceAgent || "main";
    return `agent:${agentId}:cli:${this.getPeerId()}`;
  }

  private async printBanner() {
    const workspace = this.kernel.getWorkspace();
    const projectWorkspace = this.kernel.getProjectWorkspace();
    const workdir = this.kernel.getWorkdir();
    const agents = this.kernel.listAgents();
    const activeModel = this.kernel.getCurrentModelKey();
    const modelConfig = this.kernel.getCurrentModelConfig();

    let cronCount = 0;
    try {
      const cron = this.kernel.tryConsume<any>("cron");
      cronCount = cron?.jobs?.length || 0;
    } catch {}
    let skillCount = 0;
    try {
      const skills = this.kernel.tryConsume<SkillsManager>("skills");
      skillCount = skills?.skills?.length || 0;
    } catch {}
    let hbStatus = "off";
    try {
      const hb = this.kernel.tryConsume<any>("heartbeat");
      if (hb) hbStatus = "on";
    } catch {}

    console.log(`\n\x1b[2m${"=".repeat(64)}\x1b[0m`);
    console.log(`  \x1b[1mclaw0  |  Unified Agent Framework\x1b[0m`);
    console.log(
      `  Model: \x1b[36m${activeModel}\x1b[0m (${modelConfig.modelId})`
    );
    console.log(`  Workdir:          ${workdir}`);
    console.log(`  Workspace:        ${workspace}`);
    console.log(`  Project Workspace: ${projectWorkspace}`);
    console.log(
      `  Agents: \x1b[32m${agents.map((a) => a.id).join(", ")}\x1b[0m`
    );
    console.log(`  Heartbeat: ${hbStatus}`);
    console.log(`  Cron jobs: ${cronCount}`);
    console.log(`  Skills: ${skillCount}`);
    console.log(
      `  \x1b[33m/help\x1b[0m for commands. \x1b[33mquit/exit\x1b[0m to leave.`
    );
    console.log(`\x1b[2m${"=".repeat(64)}\x1b[0m\n`);
  }

  private async promptLoop() {
    let rl: readline.Interface;
    const askQuestion = (query: string): Promise<string> =>
      new Promise((resolve) => {
        if (rl) rl.close();
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(query, resolve);
      });

    let processingPromise: Promise<void> | null = null;

    while (true) {
      const currentModelKey = this.kernel.getCurrentModelKey();
      const agentHint = this.forceAgent ? `:${this.forceAgent}` : "";
      const sessionHint = this.sessionLabel ? `/${this.sessionLabel}` : "";
      const userInput = (
        await askQuestion(
          `\x1b[36m\x1b[1mYou [${currentModelKey}${agentHint}${sessionHint}] > \x1b[0m`
        )
      ).trim();

      if (!userInput) continue;
      if (
        userInput.toLowerCase() === "quit" ||
        userInput.toLowerCase() === "exit"
      ) {
        console.log("Goodbye.");
        await this.kernel.stop();
        process.exit(0);
      }
      if (userInput.startsWith("/")) {
        await this.handleCommand(userInput);
        continue;
      }

      const msg: InboundMessage = {
        text: userInput,
        senderId: "cli-user",
        channel: "cli",
        accountId: "cli-local",
        peerId: this.getPeerId(),
        isGroup: false,
        media: [],
        raw: {},
      };

      // If the kernel is already processing for this session, we enqueue the message as an interrupt.
      // Otherwise, we kick off a new processing cycle.
      if (processingPromise) {
        this.kernel.enqueueUserMessage(msg);
        console.log(
          `\x1b[33m[Interrupt queued. Waiting for current process to yield...]\x1b[0m`
        );
      } else {
        processingPromise = this.kernel
          .handleMessage(msg)
          .then((response) => {
            console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${response}\n`);
          })
          .catch((err: any) => {
            console.error(`\n\x1b[31mError:\x1b[0m ${err.message}\n`);
          })
          .finally(() => {
            processingPromise = null;
          });
      }
    }
  }

  private async handleCommand(input: string) {
    const parts = input.split(" ");
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    try {
      switch (cmd) {
        case "/new":
          await this.cmdNew(arg);
          break;
        case "/list":
          await this.cmdList();
          break;
        case "/switch":
          await this.cmdSwitch(arg);
          break;
        case "/context":
          await this.cmdContext();
          break;
        case "/compact":
          await this.cmdCompact();
          break;
        case "/bindings":
          await this.cmdBindings();
          break;
        case "/route":
          await this.cmdRoute(arg);
          break;
        case "/agents":
          await this.cmdAgents();
          break;
        case "/sessions":
          await this.cmdSessions();
          break;
        case "/switch-agent":
          await this.cmdSwitchAgent(arg);
          break;
        case "/tools":
          await this.cmdTools();
          break;
        case "/soul":
        case "/memory":
        case "/bootstrap":
        case "/prompt":
          await this.cmdReadMarkdown(cmd);
          break;
        case "/skills":
          await this.cmdSkills();
          break;
        case "/search":
          await this.cmdSearch(arg);
          break;
        case "/channels":
          await this.cmdChannels();
          break;
        case "/heartbeat":
          await this.cmdHeartbeat();
          break;
        case "/trigger":
          await this.cmdTrigger();
          break;
        case "/cron":
          await this.cmdCron();
          break;
        case "/cron-trigger":
          await this.cmdCronTrigger(arg);
          break;
        case "/gateway":
          await this.cmdGateway();
          break;
        case "/models":
          await this.cmdModels();
          break;
        case "/model":
          await this.cmdModel(arg);
          break;
        case "/workdir":
          await this.cmdWorkdir();
          break;
        case "/config":
          await this.cmdConfig();
          break;
        case "/help":
          this.cmdHelp();
          break;
        default: {
          // Check if it matches a skill invocation
          const skillInvoked = await this.trySkillInvocation(input);
          if (!skillInvoked) {
            console.log(`Unknown command: ${cmd}. Type /help for commands.`);
          }
          break;
        }
      }
    } catch (err: any) {
      console.error(`\x1b[31mCommand Error:\x1b[0m ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Skill Invocation
  // ──────────────────────────────────────────────────────────

  /**
   * Try to match the user input against a registered skill invocation.
   * If matched, render the skill content (including dynamic commands)
   * and send it as a contextual user message to the agent.
   *
   * Returns true if a skill was invoked (or rejected), false if no match.
   */
  private async trySkillInvocation(input: string): Promise<boolean> {
    const skillsMgr = this.kernel.tryConsume<SkillsManager>("skills");
    if (!skillsMgr || skillsMgr.skills.length === 0) return false;

    const skill = skillsMgr.findByInvocation(input);
    if (!skill) return false;

    if (!skill.userInvocable) {
      console.log(
        `\x1b[33mSkill '${skill.name}' is not user-invocable (background only).\x1b[0m`
      );
      return true;
    }

    // Extract arguments after the invocation prefix
    const invocationPrefix = skill.invocation;
    const args = input.slice(invocationPrefix.length).trim();

    console.log(`\x1b[36m[Activating skill: ${skill.name}]\x1b[0m`);

    try {
      const rendered = await skillsMgr.renderSkill(
        skill,
        this.kernel.getWorkdir()
      );

      const contextParts: string[] = [`[Skill activated: ${skill.name}]`];
      if (skill.allowedTools.length > 0) {
        contextParts.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
      }
      if (rendered) contextParts.push(rendered);
      if (args) contextParts.push(`User arguments: ${args}`);

      const msg: InboundMessage = {
        text: contextParts.join("\n\n"),
        senderId: "cli-user",
        channel: "cli",
        accountId: "cli-local",
        peerId: this.getPeerId(),
        isGroup: false,
        media: [],
        raw: {},
      };

      const response = await this.kernel.handleMessage(msg);
      console.log(`\n\x1b[32m\x1b[1mAssistant:\x1b[0m ${response}\n`);
    } catch (err: any) {
      console.error(`\x1b[31mSkill error:\x1b[0m ${err.message}`);
    }

    return true;
  }

  private cmdHelp() {
    console.log(`
\x1b[1mSession:\x1b[0m
  /new [label]       Start a new session or reset current
  /list              List sessions with indices
  /switch <index>    Switch to a session by index
  /context           Show token count for current session
  /compact           Compact current session history

\x1b[1mRouting:\x1b[0m
  /bindings          Show route binding table
  /route <ch> <peer> Resolve which agent handles a channel+peer
  /agents            List registered agents
  /sessions          List all sessions with indices
  /switch-agent <id|off>  Force route to a specific agent

\x1b[1mTools:\x1b[0m
  /tools             List currently available tools

\x1b[1mIntel:\x1b[0m
  /soul              Show SOUL.md
  /skills            List discovered skills
  /memory            Show MEMORY.md
  /search <query>    Search long-term memories
  /prompt            Show IDENTITY.md
  /bootstrap         Show BOOTSTRAP.md

\x1b[1mChannels:\x1b[0m
  /channels          Show channel info and ephemeral status

\x1b[1mProactive:\x1b[0m
  /heartbeat         Show heartbeat status
  /trigger           Manually trigger heartbeat
  /cron              List cron jobs
  /cron-trigger <id> Manually trigger a cron job

\x1b[1mGateway:\x1b[0m
  /gateway           Start WebSocket gateway

\x1b[1mSystem:\x1b[0m
  /models            List available models
  /model <key>       Switch active model
  /config            Show current config
  /workdir           Show workspace paths
  /exit              Quit the REPL
`);
  }

  // ── Session commands ─────────────────────────────────────

  private async cmdNew(arg: string) {
    if (arg) {
      this.sessionLabel = arg;
    } else {
      const sk = this.getSessionKey();
      this.kernel.getSessionStore().clear(sk);
      console.log(`\n  \x1b[32mSession reset: ${sk}\x1b[0m\n`);
      return;
    }
    console.log(`\n  \x1b[32mNew session: ${this.getSessionKey()}\x1b[0m\n`);
  }

  private async cmdList() {
    await this.cmdSessions();
  }

  private async cmdSwitch(arg: string) {
    if (!arg) {
      console.log("Usage: /switch <index>  (use /list to see indices)");
      return;
    }
    const sessions = this.kernel.getSessionStore().list();
    const idx = parseInt(arg, 10);
    if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
      console.log(
        `\x1b[31mInvalid index. Use /list to see available sessions.\x1b[0m`
      );
      return;
    }
    const target = sessions[idx];
    const match = target.key.match(/^agent:([^:]+):([^:]+):(.+)$/);
    if (!match) {
      console.log(`\x1b[31mCannot parse session key: ${target.key}\x1b[0m`);
      return;
    }
    const [, agentId, channel, peerId] = match;
    this.forceAgent = agentId === "main" ? "" : agentId;
    if (peerId.startsWith("agent:")) {
      const baseMatch = peerId.match(/^agent:[^:]+:cli-user(?::(.+))?$/);
      this.sessionLabel = baseMatch?.[1] || "";
    } else if (peerId === "cli-user") {
      this.sessionLabel = "";
    } else if (peerId.startsWith("cli-user:")) {
      this.sessionLabel = peerId.slice("cli-user:".length);
    } else {
      this.sessionLabel = "";
    }
    console.log(`\n  \x1b[32mSwitched to: ${target.key}\x1b[0m`);
    console.log(
      `  Agent: ${agentId}, Channel: ${channel}, ${target.messageCount} messages\n`
    );
  }

  private async cmdContext() {
    const sk = this.getSessionKey();
    const msgs = await this.kernel.getSessionStore().load(sk);
    const tokens = this.kernel.getSessionStore().estimateTokens(msgs);
    console.log(
      `\n  Context: ~${tokens.toLocaleString()} tokens (${
        msgs.length
      } messages)  Session: ${sk}\n`
    );
  }

  private async cmdCompact() {
    const sk = this.getSessionKey();
    const msgs = await this.kernel.getSessionStore().load(sk);
    const modelConfig = this.kernel.getCurrentModelConfig();
    const compacted = await this.kernel
      .getSessionStore()
      .compact(msgs, modelConfig);
    await this.kernel.getSessionStore().save(sk, compacted);
    console.log(
      `\n  Compacted: ${msgs.length} -> ${compacted.length} messages\n`
    );
  }

  // ── Routing commands ─────────────────────────────────────

  private async cmdBindings() {
    const bt = this.kernel.tryConsume<any>("bindings");
    if (!bt) {
      console.log("Routing plugin not loaded.");
      return;
    }
    const all = bt.listAll();
    console.log("\n\x1b[1mRoute Bindings:\x1b[0m");
    for (const b of all)
      console.log(
        `  [tier ${b.tier}] ${b.matchKey}=${b.matchValue} -> ${b.agentId}`
      );
    console.log("");
  }

  private async cmdRoute(arg: string) {
    const routeParts = arg.split(/\s+/);
    const channel = routeParts[0] || "cli";
    const peerId = routeParts[1] || "cli-user";
    const bt = this.kernel.tryConsume<any>("bindings");
    if (!bt) {
      console.log("Routing plugin not loaded.");
      return;
    }
    const [agentId] = bt.resolve(channel, "", "", peerId);
    const sessionKey = `agent:${agentId || "main"}:${channel}:${peerId}`;
    console.log(`\n  channel=${channel}  peerId=${peerId}`);
    console.log(
      `  => Agent: \x1b[36m${
        agentId || "(none)"
      }\x1b[0m  Session: ${sessionKey}\n`
    );
  }

  private async cmdAgents() {
    const agents = this.kernel.listAgents();
    console.log("\n\x1b[1mAgents:\x1b[0m");
    for (const a of agents)
      console.log(
        `  \x1b[36m${a.id}\x1b[0m (${a.name}) ${
          a.personality ? "- " + a.personality : ""
        }`
      );
    console.log("");
  }

  private async cmdSessions() {
    const sessions = this.kernel.getSessionStore().list();
    if (!sessions.length) {
      console.log("\nNo active sessions.\n");
      return;
    }
    console.log("\n\x1b[1mSessions:\x1b[0m");
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const current =
        s.key === this.getSessionKey() ? " \x1b[32m<--\x1b[0m" : "";
      console.log(
        `  [${i}] ${s.key} (${s.messageCount} msgs)${
          s.ephemeral ? " \x1b[33m[ephemeral]\x1b[0m" : ""
        }${current}`
      );
    }
    console.log("");
  }

  private async cmdSwitchAgent(arg: string) {
    if (!arg || arg.toLowerCase() === "off") {
      this.forceAgent = "";
      console.log("Routing restored to default.");
      return;
    }
    if (!this.kernel.getAgent(arg)) {
      console.log(`\x1b[31mAgent '${arg}' not found.\x1b[0m`);
      return;
    }
    this.forceAgent = arg;
    console.log(`\x1b[32mForcing agent: ${arg}\x1b[0m`);
  }

  // ── Tools command ────────────────────────────────────────

  private async cmdTools() {
    const tools = this.kernel.getTools();
    if (!tools.length) {
      console.log("\n  No tools available.\n");
      return;
    }
    console.log("\n\x1b[1mAvailable Tools:\x1b[0m");
    for (const t of tools) {
      const fn = t.function;
      const paramInfo = fn.parameters?.properties
        ? Object.keys(fn.parameters.properties)
            .map((k) => {
              // @ts-ignore
              const p: any = fn.parameters!.properties[k];
              // @ts-ignore
              const req = fn.parameters!.required?.includes(k) ? "*" : "";
              return `${k}${req}: ${p.type || "any"}`;
            })
            .join(", ")
        : "";
      console.log(`  \x1b[36m${fn.name}\x1b[0m`);
      console.log(`    ${fn.description || ""}`);
      if (paramInfo) console.log(`    Params: ${paramInfo}`);
    }
    console.log("");
  }

  // ── Intel commands ───────────────────────────────────────

  private async cmdReadMarkdown(cmd: string) {
    const workspace = this.kernel.getWorkspace();
    const projectWorkspace = this.kernel.getProjectWorkspace();
    const fileMap: Record<string, { global: string; project?: string }> = {
      "/soul": { global: "SOUL.md" },
      "/memory": { global: "MEMORY.md", project: "MEMORY.md" },
      "/bootstrap": { global: "BOOTSTRAP.md" },
      "/prompt": { global: "IDENTITY.md" },
    };
    const mapping = fileMap[cmd];
    let combined = "";
    if (mapping.project) {
      const projPath = path.join(projectWorkspace, mapping.project);
      try {
        const content = (await fs.readFile(projPath, "utf-8")).trim();
        if (content) combined += `\x1b[36m[Project]\x1b[0m\n${content}\n\n`;
      } catch {}
    }
    const globalPath = path.join(workspace, mapping.global);
    try {
      const content = (await fs.readFile(globalPath, "utf-8")).trim();
      if (content) combined += `\x1b[33m[Global]\x1b[0m\n${content}\n`;
    } catch {}
    console.log(`\n${combined || "(File not found)"}\n`);
  }

  private async cmdSkills() {
    const skillsMgr = this.kernel.tryConsume<SkillsManager>("skills");
    if (!skillsMgr) {
      console.log("Skills plugin not loaded.");
      return;
    }
    if (skillsMgr.skills.length === 0) {
      console.log("\n  No skills available.\n");
      return;
    }
    console.log("\n\x1b[1mSkills:\x1b[0m");
    for (const s of skillsMgr.skills) {
      const invocationParts = [s.invocation];
      if (s.argumentHint) invocationParts.push(s.argumentHint);

      let line = `  \x1b[36m${s.name}\x1b[0m`;
      line += ` (\x1b[33m${invocationParts.join(" ")}\x1b[0m)`;
      if (s.disableModelInvocation) line += " \x1b[31m[manual only]\x1b[0m";
      if (!s.userInvocable) line += " \x1b[2m[background]\x1b[0m";
      console.log(line);
      console.log(`    ${s.description.slice(0, 100)}`);
      if (s.allowedTools.length > 0) {
        console.log(
          `    \x1b[2mAllowed tools: ${s.allowedTools.join(", ")}\x1b[0m`
        );
      }
    }
    console.log(
      `\n  \x1b[2mType a skill's invocation (e.g. /example) to activate it.\x1b[0m\n`
    );
  }

  private async cmdSearch(arg: string) {
    if (!arg) {
      console.log("Usage: /search <query>");
      return;
    }
    const workspace = this.kernel.getWorkspace();
    const projectWorkspace = this.kernel.getProjectWorkspace();
    const queryLower = arg.toLowerCase();
    const matches: string[] = [];
    for (const memPath of [
      path.join(workspace, "MEMORY.md"),
      path.join(projectWorkspace, "MEMORY.md"),
    ]) {
      try {
        const text = (await fs.readFile(memPath, "utf-8")).trim();
        for (const para of text.split("\n\n")) {
          if (para.toLowerCase().includes(queryLower)) matches.push(para);
        }
      } catch {}
    }
    for (const memDir of [
      path.join(workspace, "memory", "daily"),
      path.join(projectWorkspace, "memory", "daily"),
    ]) {
      await this.searchDailyMemoryDir(memDir, queryLower, matches);
    }
    if (matches.length) {
      console.log(`\n\x1b[1mSearch results for "${arg}":\x1b[0m`);
      for (const m of matches.slice(0, 10))
        console.log(`  \u2022 ${m.replace(/\n/g, "\n    ")}`);
      console.log("");
    } else {
      console.log(`\n  No memories matching '${arg}'.\n`);
    }
  }

  private async searchDailyMemoryDir(
    dir: string,
    queryLower: string,
    matches: string[]
  ) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files.filter((f) => f.endsWith(".jsonl")).slice(-7)) {
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

  // ── Channel commands ─────────────────────────────────────

  private async cmdChannels() {
    const ephemeralChannels = this.kernel.getEphemeralChannels();
    const config = this.kernel.getConfig();
    const knownChannels = [
      { id: "cli", description: "CLI terminal REPL" },
      { id: "telegram", description: "Telegram bot" },
      { id: "websocket", description: "WebSocket gateway" },
      { id: "background", description: "Background / cron / heartbeat tasks" },
    ];
    console.log("\n\x1b[1mChannels:\x1b[0m");
    for (const ch of knownChannels) {
      const ephemeral = ephemeralChannels.has(ch.id);
      const channelConfig = config.channels[ch.id];
      const extra = channelConfig
        ? Object.entries(channelConfig)
            .filter(([k]) => k !== "ephemeral")
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "";
      console.log(
        `  ${ch.id.padEnd(12)} ${ch.description}${
          ephemeral
            ? "  \x1b[33m[ephemeral]\x1b[0m"
            : "  \x1b[2m[persisted]\x1b[0m"
        }${extra ? `  \x1b[2m(${extra})\x1b[0m` : ""}`
      );
    }
    for (const ch of ephemeralChannels) {
      if (!knownChannels.some((k) => k.id === ch))
        console.log(`  ${ch.padEnd(12)} (custom)  \x1b[33m[ephemeral]\x1b[0m`);
    }
    console.log("");
  }

  // ── Proactive commands ───────────────────────────────────

  private async cmdHeartbeat() {
    const hb = this.kernel.tryConsume<any>("heartbeat");
    if (!hb) {
      console.log("Heartbeat plugin not loaded.");
      return;
    }
    console.log("\n  Heartbeat is running.\n");
  }

  private async cmdTrigger() {
    const hb = this.kernel.tryConsume<any>("heartbeat");
    if (!hb) {
      console.log("Heartbeat plugin not loaded.");
      return;
    }
    hb.trigger(this.kernel);
    console.log("\n  Heartbeat triggered.\n");
  }

  private async cmdCron() {
    const cron = this.kernel.tryConsume<any>("cron");
    if (!cron) {
      console.log("Cron plugin not loaded.");
      return;
    }
    console.log("\n\x1b[1mCron Jobs:\x1b[0m");
    for (const j of cron.jobs) {
      const nextRun = j.nextRunAt
        ? new Date(j.nextRunAt * 1000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19)
        : "-";
      console.log(
        `  [${
          j.enabled ? "\x1b[32mON\x1b[0m" : "\x1b[31mOFF\x1b[0m"
        }] ${j.id.padEnd(20)} ${j.name.padEnd(20)} next: ${nextRun}`
      );
    }
    console.log("");
  }

  private async cmdCronTrigger(arg: string) {
    if (!arg) {
      console.log("Usage: /cron-trigger <job-id>");
      return;
    }
    const cron = this.kernel.tryConsume<any>("cron");
    if (!cron) {
      console.log("Cron plugin not loaded.");
      return;
    }
    const job = cron.jobs.find((j: any) => j.id === arg);
    if (!job) {
      console.log(`\x1b[31mCron job '${arg}' not found.\x1b[0m`);
      return;
    }
    if (!job.enabled) {
      console.log(`\x1b[33mCron job '${arg}' is disabled.\x1b[0m`);
      return;
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
      console.log(
        `\n  \x1b[32mTriggered cron job: ${job.id} (${job.name})\x1b[0m\n`
      );
    } else {
      console.log(
        `\x1b[33mCron job '${arg}' has no agent_turn payload.\x1b[0m`
      );
    }
  }

  // ── Gateway commands ─────────────────────────────────────

  private async cmdGateway() {
    const gw = this.kernel.tryConsume<any>("gateway");
    if (!gw) {
      console.log("Gateway plugin not loaded.");
      return;
    }
    try {
      await gw.start();
    } catch (err: any) {
      console.log(`Gateway error: ${err.message}`);
    }
  }

  // ── System commands ──────────────────────────────────────

  private async cmdModels() {
    const models = this.kernel.listModels();
    const active = this.kernel.getCurrentModelKey();
    const config = this.kernel.getConfig();
    console.log("\n\x1b[1mAvailable Models:\x1b[0m");
    for (const [k, v] of Object.entries(models)) {
      const entry = config.models[k];
      const provider = entry?.provider || "?";
      const marker = k === active ? "\x1b[32m-> \x1b[0m" : "   ";
      console.log(`  ${marker}${k}: ${v} (provider: ${provider})`);
    }
    console.log("");
  }

  private async cmdModel(arg: string) {
    if (!arg) {
      console.log("Usage: /model <key>");
      return;
    }
    this.kernel.switchModel(arg);
  }

  private async cmdConfig() {
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
    console.log("\n\x1b[1mCurrent Config:\x1b[0m");
    console.log(
      JSON.stringify({ ...config, providers: maskedProviders }, null, 2)
    );
    console.log("");
  }

  private async cmdWorkdir() {
    console.log(
      `\nWorkdir:          ${this.kernel.getWorkdir()}\nWorkspace:        ${this.kernel.getWorkspace()}\nProject Workspace: ${this.kernel.getProjectWorkspace()}\n`
    );
  }
}
