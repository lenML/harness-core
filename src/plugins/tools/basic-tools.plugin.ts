import path from "node:path";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  CoreContext,
  AgentPlugin,
  ToolDef,
  IFileTransactionManager,
} from "../../types";

const execPromise = promisify(exec);

export class BasicToolsPlugin implements AgentPlugin {
  name = "basic-tools";
  async install(ctx: CoreContext) {
    const workdir = ctx.getWorkdir();
    const workspace = ctx.getWorkspace();

    function isValidBase(dir: string): boolean {
      const resolved = path.resolve(dir);
      return resolved.startsWith(workdir) || resolved.startsWith(workspace);
    }

    function safePath(raw: string, baseCwd?: string): string {
      const effectiveBase =
        baseCwd && isValidBase(path.resolve(baseCwd))
          ? path.resolve(baseCwd)
          : workdir;
      const resolved = path.resolve(effectiveBase, raw);
      if (!isValidBase(resolved))
        throw new Error(
          `Path traversal blocked: ${raw} resolves outside allowed directories`
        );
      return resolved;
    }

    function getTransaction(
      ctx: CoreContext
    ): IFileTransactionManager | undefined {
      return ctx.tryConsume<IFileTransactionManager>("fileTransaction");
    }

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "bash",
          description:
            "Run a shell command. This tool cannot be interrupted once started.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              timeout: { type: "number" },
              cwd: {
                type: "string",
                description:
                  "Directory to run command in. Defaults to workdir.",
              },
            },
            required: ["command"],
          },
        },
      },
      handler: async (args) => {
        const timeout = (args.timeout || 30) * 1000;
        const execCwd =
          args.cwd && isValidBase(path.resolve(args.cwd))
            ? path.resolve(args.cwd)
            : workdir;
        try {
          const { stdout, stderr } = await execPromise(args.command, {
            cwd: execCwd,
            timeout,
          });
          return stdout || stderr || "[no output]";
        } catch (error: any) {
          return `Error: ${error.message}\n${error.stdout || ""}`;
        }
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      interruptible: false, // 不可中断
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "list_directory",
          description: "List files and subdirectories.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, cwd: { type: "string" } },
          },
        },
      },
      handler: async (args) => {
        try {
          const entries = await fs.readdir(
            safePath(args.path || ".", args.cwd),
            { withFileTypes: true }
          );
          return (
            entries
              .map((e) => (e.isDirectory() ? "[dir]  " : "[file] ") + e.name)
              .join("\n") || "[empty]"
          );
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read file contents.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              cwd: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      },
      handler: async (args) => {
        try {
          const target = safePath(args.file_path, args.cwd);
          const tx = getTransaction(ctx);
          let content: string;
          if (tx && tx.exists(target)) {
            content = await tx.readFile(target);
          } else {
            content = await fs.readFile(target, "utf-8");
          }
          return content.length > 50000
            ? content.slice(0, 50000) + "\n... [truncated]"
            : content;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Write content to a file. Can be interrupted.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
              cwd: { type: "string" },
            },
            required: ["file_path", "content"],
          },
        },
      },
      handler: async (args) => {
        try {
          const target = safePath(args.file_path, args.cwd);
          const tx = getTransaction(ctx);
          if (tx) {
            await tx.stageWrite(target, args.content);
          } else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, args.content, "utf-8");
          }
          return `Successfully wrote to ${args.file_path}`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      interruptible: true, // 可中断
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace an exact string in a file. Can be interrupted.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" },
              cwd: { type: "string" },
            },
            required: ["file_path", "old_string", "new_string"],
          },
        },
      },
      handler: async (args) => {
        try {
          const target = safePath(args.file_path, args.cwd);
          const tx = getTransaction(ctx);
          let content: string;
          if (tx) {
            content = await tx.readFile(target);
          } else {
            content = await fs.readFile(target, "utf-8");
          }
          if (content.split(args.old_string).length - 1 !== 1)
            return "Error: old_string must appear exactly once.";
          const newContent = content.replace(args.old_string, args.new_string);
          if (tx) {
            await tx.stageWrite(target, newContent);
          } else {
            await fs.writeFile(target, newContent, "utf-8");
          }
          return `Successfully edited ${args.file_path}`;
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
      },
      isReadOnly: false,
      isConcurrencySafe: false,
      interruptible: true, // 可中断
    } as ToolDef);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "get_current_time",
          description: "Get current UTC time.",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () =>
        new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
      isReadOnly: true,
      isConcurrencySafe: true,
    } as ToolDef);
  }
}
