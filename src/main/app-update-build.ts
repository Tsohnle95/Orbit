import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const REQUIRED_BUILD_FILES = ["main/index.js", "preload/index.js", "renderer/index.html"];

export function stagingOutputName(): string {
  return `.orbit-update-stage-${randomUUID()}`;
}

export async function swapBuiltOutput(projectRoot: string, stagingName: string): Promise<void> {
  if (!/^\.orbit-update-stage-[0-9a-f-]{36}$/i.test(stagingName)) {
    throw new Error("The staged build directory has an invalid name.");
  }

  const root = path.resolve(projectRoot);
  const staged = path.join(root, stagingName);
  const output = path.join(root, "out");
  for (const file of REQUIRED_BUILD_FILES) {
    try {
      const details = await fsp.stat(path.join(staged, file));
      if (!details.isFile() || details.size === 0) throw new Error();
    } catch {
      throw new Error(`The staged build is incomplete: ${file} is missing or empty.`);
    }
  }

  const backup = path.join(root, `.orbit-update-backup-${randomUUID()}`);
  let movedOutput = false;
  try {
    await fsp.rename(output, backup);
    movedOutput = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await fsp.rename(staged, output);
  } catch (error) {
    if (movedOutput) {
      try {
        await fsp.rename(backup, output);
      } catch (restoreError) {
        const original = error instanceof Error ? error.message : String(error);
        const restore = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(`Could not install the staged Orbit build (${original}) or restore the previous build (${restore}).`);
      }
    }
    throw error;
  }

  if (movedOutput) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
}
