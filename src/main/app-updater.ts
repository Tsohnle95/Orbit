import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { OrbitAppUpdateResult, OrbitAppUpdateStatus } from "@shared/types";
import { stagingOutputName, swapBuiltOutput } from "./app-update-build";
import { integrateGitHubSource } from "./app-update-git";

interface CommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  options: CommandOptions
) => Promise<string>;

interface OrbitAppUpdaterOptions {
  nodePath?: string;
  run?: CommandRunner;
}

const UPDATE_BRANCH = "main";
const UPDATE_REMOTE = "https://github.com/tsohnle95/orbit";

function appendTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString()}`.slice(-12_000);
}

const runCommand: CommandRunner = (command, args, cwd, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd,
    env: options.env,
    shell: process.platform === "win32" && command === "npm",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    child.kill();
    finish(() => reject(new Error(`${command} ${args[0] ?? ""} timed out`)));
  }, options.timeoutMs);
  const finish = (action: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };

  child.stdout.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
  child.on("error", (error) => finish(() => reject(error)));
  child.on("close", (code) => {
    if (code === 0) {
      finish(() => resolve(stdout.trim()));
      return;
    }
    const detail = (stderr || stdout).trim();
    finish(() => reject(new Error(detail || `${command} exited with code ${code ?? "unknown"}`)));
  });
});

function canonicalRemote(value: string): boolean {
  const normalized = value.trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized === UPDATE_REMOTE;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function createOrbitAppUpdater(projectRoot: string, options: OrbitAppUpdaterOptions = {}) {
  const root = path.resolve(projectRoot);
  const run = options.run ?? runCommand;
  const env = { ...process.env };
  if (options.nodePath) {
    const nodeDirectory = path.dirname(options.nodePath);
    env.PATH = [nodeDirectory, env.PATH].filter(Boolean).join(path.delimiter);
  }
  delete env.ELECTRON_RUN_AS_NODE;
  let updateInProgress = false;

  const command = (program: string, args: string[], timeoutMs = 120_000): Promise<string> =>
    run(program, args, root, { env, timeoutMs });
  const git = (args: string[]): Promise<string> => command("git", args);

  async function readStatus(duringUpdate = false): Promise<OrbitAppUpdateStatus> {
    if (updateInProgress && !duringUpdate) return { state: "blocked", message: "An Orbit update is already running." };

    try {
      let gitRoot: string;
      try {
        gitRoot = path.resolve(await git(["rev-parse", "--show-toplevel"]));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { state: "blocked", message: `GitHub updates require an Orbit source checkout. ${detail}` };
      }
      if (gitRoot !== root) {
        return { state: "blocked", message: "Orbit updates are only available from the Orbit source checkout." };
      }

      const remote = await git(["remote", "get-url", "origin"]);
      if (!canonicalRemote(remote)) {
        return { state: "blocked", message: "Orbit updates require origin to point to github.com/Tsohnle95/Orbit." };
      }

      const branch = await git(["branch", "--show-current"]);
      const currentCommit = await git(["rev-parse", "HEAD"]);
      if (branch !== UPDATE_BRANCH) {
        return {
          state: "blocked",
          branch,
          currentCommit,
          message: `Orbit updates follow ${UPDATE_BRANCH}. Switch this checkout from ${branch || "detached HEAD"} to ${UPDATE_BRANCH} first.`
        };
      }

      await git(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const latestCommit = await git(["rev-parse", "refs/remotes/origin/main"]);
      try {
        await git(["merge-base", "HEAD", latestCommit]);
      } catch {
        return {
          state: "blocked",
          branch,
          currentCommit,
          message: "This checkout does not share Git history with GitHub main. Orbit left it unchanged."
        };
      }
      const changes = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
      const counts = await git(["rev-list", "--left-right", "--count", `HEAD...${latestCommit}`]);
      const match = /^(\d+)\s+(\d+)$/.exec(counts.trim());
      if (!match) throw new Error("Git returned an unreadable commit count.");
      const commitsAhead = Number(match[1]);
      const commitsBehind = Number(match[2]);
      if (commitsBehind === 0) {
        return { state: "current", branch, currentCommit, latestCommit, commitsBehind: 0, commitsAhead, hasLocalChanges: Boolean(changes.trim()) };
      }
      return { state: "available", branch, currentCommit, latestCommit, commitsBehind, commitsAhead, hasLocalChanges: Boolean(changes.trim()) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "blocked", message: `Could not check GitHub for Orbit updates: ${detail}` };
    }
  }

  async function check(): Promise<OrbitAppUpdateStatus> {
    return readStatus();
  }

  async function update(onProgress?: (message: string) => void): Promise<OrbitAppUpdateResult> {
    if (updateInProgress) return { ok: false, updated: false, message: "An Orbit update is already running." };
    updateInProgress = true;
    const reportProgress = (message: string): void => {
      try {
        onProgress?.(message);
      } catch {
        // A closed progress window must not interrupt the source update.
      }
    };
    let sourceCommit: string | null = null;
    const stagingName = stagingOutputName();
    try {
      reportProgress("Checking GitHub for updates…");
      const status = await readStatus(true);
      if (status.state === "blocked") return { ok: false, updated: false, message: status.message };

      reportProgress("Checking the supported Node.js and npm versions…");
      const nodeVersion = await command(options.nodePath ?? "node", ["--version"], 10_000);
      const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(nodeVersion);
      if (!version || Number(version[1]) !== 22 || Number(version[2]) < 23 || (Number(version[2]) === 23 && Number(version[3]) < 2)) {
        return {
          ok: false,
          updated: false,
          message: `Updating Orbit requires Node.js 22.23.2 or newer in the 22.x series; found ${nodeVersion || "an unknown version"}.`
        };
      }
      await command("npm", ["--version"], 10_000);

      if (status.state === "current") {
        reportProgress("GitHub is current; rebuilding this Orbit version…");
      }

      sourceCommit = await integrateGitHubSource(git, {
        expectedHead: status.currentCommit,
        latestCommit: status.latestCommit,
        commitsBehind: status.commitsBehind,
        onProgress: reportProgress
      });

      reportProgress("Installing app dependencies…");
      await command("npm", ["install", "--no-audit", "--no-fund"], 10 * 60_000);
      reportProgress("Building the updated app in a staging directory…");
      await command("npm", ["run", "build:compile", "--", "--outDir", stagingName], 10 * 60_000);
      reportProgress("Checking and installing the staged build…");
      await swapBuiltOutput(root, stagingName);
      const localNotes = [
        status.commitsAhead > 0 ? `Preserved ${status.commitsAhead} local commit${status.commitsAhead === 1 ? "" : "s"}.` : "",
        status.hasLocalChanges ? "Restored local file changes." : ""
      ].filter(Boolean).join(" ");
      return {
        ok: true,
        updated: true,
        currentCommit: status.currentCommit,
        latestCommit: status.latestCommit,
        message: `${status.state === "available"
          ? `Orbit now includes GitHub commit ${shortCommit(status.latestCommit)} and has been rebuilt.`
          : `Orbit is current at GitHub commit ${shortCommit(status.latestCommit)} and has been rebuilt.`}${localNotes ? ` ${localNotes}` : ""}`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prefix = sourceCommit
        ? `Orbit source is now at ${shortCommit(sourceCommit)}, but dependency setup or the build failed.`
        : "Orbit could not be updated.";
      return { ok: false, updated: false, currentCommit: sourceCommit ?? undefined, message: `${prefix} ${detail}` };
    } finally {
      await fsp.rm(path.join(root, stagingName), { recursive: true, force: true }).catch(() => {});
      updateInProgress = false;
    }
  }

  return { check, update };
}
