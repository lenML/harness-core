import type {
  CoreContext,
  ToolDef,
  ToolCallInfo,
  ToolCallResult,
  IFileTransactionManager,
} from "../types";
import { FileTransactionManager } from "./file-transaction";

export class ToolExecutor {
  private ctx: CoreContext;
  private tools: Map<string, ToolDef>;
  private maxConcurrency: number;

  constructor(
    ctx: CoreContext,
    tools: Map<string, ToolDef>,
    maxConcurrency = 10
  ) {
    this.ctx = ctx;
    this.tools = tools;
    this.maxConcurrency = maxConcurrency;
  }

  logToolCalls(toolCalls: ToolCallInfo[]): void {
    for (const call of toolCalls) {
      let detail = call.arguments;
      if (detail.length > 64) detail = detail.slice(0, 64) + "...";
      console.log(`  [🔧${call.functionName}] ${detail}`);
    }
  }

  async execute(
    toolCalls: ToolCallInfo[],
    signal?: AbortSignal
  ): Promise<ToolCallResult[]> {
    if (toolCalls.length === 0) return [];
    this.logToolCalls(toolCalls);

    const phases = this.planPhases(toolCalls);
    const results: ToolCallResult[] = [];

    const needsTransaction = toolCalls.some((tc) => {
      const def = this.tools.get(tc.functionName);
      return def && def.isReadOnly !== true;
    });

    let tx: FileTransactionManager | null = null;
    if (needsTransaction) {
      tx = new FileTransactionManager();
      this.ctx.provide("fileTransaction", tx);
    }

    try {
      for (const phase of phases) {
        const phaseHasNonTransactionalWrite = phase.some((tc) => {
          const def = this.tools.get(tc.functionName);
          return (
            def?.isReadOnly !== true &&
            !this.isTransactionalTool(tc.functionName)
          );
        });

        if (phaseHasNonTransactionalWrite && tx && tx.hasChanges) {
          await tx.commit();
          tx = new FileTransactionManager();
          this.ctx.provide("fileTransaction", tx);
        }

        const phaseResults = await this.executePhase(phase, signal);
        results.push(...phaseResults);
      }

      if (tx && tx.hasChanges) {
        try {
          await tx.commit();
        } catch (commitErr: any) {
          console.error(
            "[ToolExecutor] Commit failed, rolling back:",
            commitErr
          );
          try {
            await tx.rollback();
          } catch {}
        }
      }
    } catch (err) {
      if (tx && tx.hasChanges) {
        try {
          await tx.rollback();
        } catch {}
      }
      throw err;
    } finally {
      this.ctx.provide("fileTransaction", undefined as any);
      try {
        this.ctx.consume<any>("fileTransaction");
      } catch {}
    }

    return results;
  }

  private isTransactionalTool(functionName: string): boolean {
    return ["write_file", "edit_file"].includes(functionName);
  }

  private planPhases(toolCalls: ToolCallInfo[]): ToolCallInfo[][] {
    const phases: ToolCallInfo[][] = [];
    let currentReadPhase: ToolCallInfo[] = [];

    for (const tc of toolCalls) {
      const def = this.tools.get(tc.functionName);
      const isReadOnly =
        def?.isReadOnly === true && def?.isConcurrencySafe !== false;

      if (isReadOnly) {
        currentReadPhase.push(tc);
      } else {
        if (currentReadPhase.length > 0) {
          phases.push(currentReadPhase);
          currentReadPhase = [];
        }
        phases.push([tc]);
      }
    }

    if (currentReadPhase.length > 0) {
      phases.push(currentReadPhase);
    }

    return phases;
  }

  private async executePhase(
    phase: ToolCallInfo[],
    signal?: AbortSignal
  ): Promise<ToolCallResult[]> {
    if (phase.length === 0) return [];
    if (phase.length === 1) {
      return [await this.executeOne(phase[0], signal)];
    }

    const results: ToolCallResult[] = [];
    for (let i = 0; i < phase.length; i += this.maxConcurrency) {
      const batch = phase.slice(i, i + this.maxConcurrency);
      const batchResults = await Promise.all(
        batch.map((tc) => this.executeOne(tc, signal))
      );
      results.push(...batchResults);
    }
    return results;
  }

  private async executeOne(
    tc: ToolCallInfo,
    signal?: AbortSignal
  ): Promise<ToolCallResult> {
    const toolDef = this.tools.get(tc.functionName);

    if (!toolDef) {
      return {
        toolCallId: tc.id,
        functionName: tc.functionName,
        content: `Error: Unknown tool '${tc.functionName}'`,
      };
    }

    if (toolDef.isEnabled === false) {
      return {
        toolCallId: tc.id,
        functionName: tc.functionName,
        content: `Error: Tool '${tc.functionName}' is currently disabled.`,
      };
    }

    // 如果已经中断，且工具是可中断的，直接返回中断结果
    if (signal?.aborted && toolDef.interruptible !== false) {
      return {
        toolCallId: tc.id,
        functionName: tc.functionName,
        content: "[Interrupted by user]",
      };
    }

    let args: any = {};
    try {
      args = JSON.parse(tc.arguments);
    } catch {}

    await this.ctx.emit("tool:before", this.ctx, {
      tool: {
        id: tc.id,
        function: { name: tc.functionName, arguments: tc.arguments },
      },
      args,
    });

    let result: string;
    const executeToolPromise = (async () => {
      try {
        return await toolDef.handler(args);
      } catch (err: any) {
        return `Error executing tool ${tc.functionName}: ${err.message}`;
      }
    })();

    // 处理可中断工具
    if (toolDef.interruptible !== false && signal) {
      const abortPromise = new Promise<string>((resolve) => {
        if (signal.aborted) {
          return resolve("[Interrupted by user]");
        }
        const onAbort = () => {
          resolve("[Interrupted by user]");
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      result = await Promise.race([executeToolPromise, abortPromise]);
    } else {
      // 不可中断工具，必须等待执行完成
      result = await executeToolPromise;
    }

    await this.ctx.emit("tool:after", this.ctx, {
      tool: { id: tc.id, function: { name: tc.functionName } },
      result,
    });

    return {
      toolCallId: tc.id,
      functionName: tc.functionName,
      content: result,
    };
  }
}
