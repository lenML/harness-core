import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { IFileTransactionManager } from "../types";

interface StagedWrite {
  content: string;
}

export class FileTransactionManager implements IFileTransactionManager {
  private stagedWrites = new Map<string, StagedWrite>();
  private stagedDeletes = new Set<string>();
  private originals = new Map<string, string | null>();

  get hasChanges(): boolean {
    return this.stagedWrites.size > 0 || this.stagedDeletes.size > 0;
  }

  async stageWrite(filePath: string, content: string): Promise<void> {
    if (!this.originals.has(filePath)) {
      try {
        const original = await fs.readFile(filePath, "utf-8");
        this.originals.set(filePath, original);
      } catch {
        this.originals.set(filePath, null);
      }
    }
    this.stagedWrites.set(filePath, { content });
    this.stagedDeletes.delete(filePath);
  }

  async stageDelete(filePath: string): Promise<void> {
    if (!this.originals.has(filePath)) {
      try {
        const original = await fs.readFile(filePath, "utf-8");
        this.originals.set(filePath, original);
      } catch {
        this.originals.set(filePath, null);
      }
    }
    this.stagedDeletes.add(filePath);
    this.stagedWrites.delete(filePath);
  }

  async readFile(filePath: string): Promise<string> {
    if (this.stagedDeletes.has(filePath)) {
      throw new Error(
        `File '${filePath}' has been deleted in this transaction`
      );
    }
    if (this.stagedWrites.has(filePath)) {
      return this.stagedWrites.get(filePath)!.content;
    }
    return fs.readFile(filePath, "utf-8");
  }

  exists(filePath: string): boolean {
    if (this.stagedDeletes.has(filePath)) return false;
    if (this.stagedWrites.has(filePath)) return true;
    return existsSync(filePath);
  }

  async commit(): Promise<void> {
    for (const [filePath, staged] of this.stagedWrites) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, staged.content, "utf-8");
    }
    for (const filePath of this.stagedDeletes) {
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    }
    this.clear();
  }

  async rollback(): Promise<void> {
    for (const [filePath, original] of this.originals) {
      if (original === null) {
        if (existsSync(filePath)) {
          await fs.unlink(filePath);
        }
      } else {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, original, "utf-8");
      }
    }
    this.clear();
  }

  private clear(): void {
    this.stagedWrites.clear();
    this.stagedDeletes.clear();
    this.originals.clear();
  }
}
