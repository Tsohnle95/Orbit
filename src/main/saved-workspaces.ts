import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectInfo, SavedWorkspaceSnapshot } from "@shared/types";

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function normalize(value: unknown): ProjectInfo[] {
  if (!Array.isArray(value)) throw new Error("Saved workspaces must be a list.");
  const seen = new Set<string>();
  return value.flatMap((item): ProjectInfo[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const workspace = item as { directory?: unknown; name?: unknown };
    if (typeof workspace.directory !== "string" || !workspace.directory.trim() || seen.has(workspace.directory)) return [];
    seen.add(workspace.directory);
    const fallbackName = workspace.directory.split(/[\\/]/).filter(Boolean).pop() ?? workspace.directory;
    return [{
      directory: workspace.directory,
      name: typeof workspace.name === "string" && workspace.name.trim() ? workspace.name : fallbackName
    }];
  });
}

function parse(raw: string): ProjectInfo[] {
  const value: unknown = JSON.parse(raw);
  if (Array.isArray(value)) return normalize(value);
  if (!value || typeof value !== "object") throw new Error("Saved workspaces file has an invalid format.");
  const stored = value as { version?: unknown; workspaces?: unknown };
  if (stored.version !== 1 || !Array.isArray(stored.workspaces)) {
    throw new Error("Saved workspaces file has an unsupported format.");
  }
  return normalize(stored.workspaces);
}

export class SavedWorkspaceStore {
  private readonly backupPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.backupPath = `${filePath}.bak`;
  }

  async read(): Promise<ProjectInfo[]> {
    try {
      return parse(await readFile(this.filePath, "utf8"));
    } catch (primaryError) {
      try {
        return parse(await readFile(this.backupPath, "utf8"));
      } catch (backupError) {
        if (isMissing(primaryError) && isMissing(backupError)) return [];
        if (isMissing(backupError)) throw primaryError;
        throw new AggregateError([primaryError, backupError], "Could not read saved workspaces or their backup.");
      }
    }
  }

  async load(): Promise<SavedWorkspaceSnapshot> {
    const workspaces = await this.read();
    const initialized = await Promise.all([this.filePath, this.backupPath].map(async (file) => {
      try {
        await access(file);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    }));
    return { workspaces, initialized: initialized.some(Boolean) };
  }

  save(value: unknown): Promise<ProjectInfo[]> {
    const workspaces = normalize(value);
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const serialized = `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`;
      try {
        let previous: string | null = null;
        try {
          previous = await readFile(this.filePath, "utf8");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        let previousIsValid = false;
        if (previous !== null) {
          try {
            parse(previous);
            previousIsValid = true;
          } catch {
            // Preserve an existing good backup when the primary file is corrupt.
          }
        }
        if (previousIsValid) {
          await copyFile(this.filePath, this.backupPath);
        } else {
          try {
            parse(await readFile(this.backupPath, "utf8"));
          } catch (error) {
            if (!isMissing(error)) throw new Error("Cannot replace saved workspaces without a readable current file or backup.");
            if (previous !== null) throw new Error("Cannot replace a corrupt saved workspaces file without a readable backup.");
          }
        }
        await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => {});
    return operation.then(() => workspaces);
  }
}
