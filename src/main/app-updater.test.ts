import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrbitAppUpdater } from "./app-updater";

const roots: string[] = [];
const current = "1111111111111111111111111111111111111111";
const latest = "2222222222222222222222222222222222222222";

function makeUpdater(overrides: {
  branch?: string;
  remote?: string;
  changes?: string;
  counts?: string;
  nodeVersion?: string;
  fetchError?: Error;
  buildFailure?: boolean;
  latestCommit?: string;
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "orbit-updater-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "out", "main"), { recursive: true });
  writeFileSync(path.join(root, "out", "main", "index.js"), "previous build");
  let merged = false;
  let workingChanges = overrides.changes ?? "";
  let stashHead: string | null = null;
  const githubCommit = overrides.latestCommit ?? latest;
  const run = vi.fn(async (command: string, args: string[], cwd: string) => {
    if (command === "node") return overrides.nodeVersion ?? "v22.23.2";
    if (command === "npm") {
      if (args[0] === "run" && args.includes("--outDir")) {
        if (overrides.buildFailure) throw new Error("synthetic build failure");
        const stageName = args[args.indexOf("--outDir") + 1];
        for (const file of ["main/index.js", "preload/index.js", "renderer/index.html"]) {
          const target = path.join(cwd, stageName, file);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, "updated build");
        }
      }
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cwd;
    if (args[0] === "remote") return overrides.remote ?? "https://github.com/Tsohnle95/Orbit.git";
    if (args[0] === "branch") return overrides.branch ?? "main";
    if (args[0] === "status") return workingChanges;
    if (args[0] === "fetch") {
      if (overrides.fetchError) throw overrides.fetchError;
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return merged ? githubCommit : current;
    if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main") return githubCommit;
    if (args[0] === "rev-parse" && args[1] === "--verify" && args.includes("refs/stash")) {
      if (!stashHead) throw new Error("no stash");
      return stashHead;
    }
    if (args[0] === "stash" && args[1] === "list") return stashHead ? `stash@{0} ${stashHead}` : "";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-list") return overrides.counts ?? "0\t3";
    if (args[0] === "update-ref") return "";
    if (args[0] === "stash" && args[1] === "push") {
      stashHead = "3333333333333333333333333333333333333333";
      workingChanges = "";
      return "";
    }
    if (args[0] === "stash" && args[1] === "apply") {
      workingChanges = overrides.changes ?? "";
      return "";
    }
    if (args[0] === "stash" && args[1] === "drop") {
      stashHead = null;
      return "";
    }
    if (args[0] === "merge") {
      merged = true;
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
  return { updater: createOrbitAppUpdater(root, { run }), run, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Orbit app updater", () => {
  it("checks GitHub main and reports the number of commits available", async () => {
    const { updater, run, root } = makeUpdater();

    await expect(updater.check()).resolves.toEqual({
      state: "available",
      branch: "main",
      currentCommit: current,
      latestCommit: latest,
      commitsBehind: 3,
      commitsAhead: 0,
      hasLocalChanges: false
    });
    expect(run).toHaveBeenCalledWith(
      "git",
      ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      root,
      expect.objectContaining({ timeoutMs: 120_000 })
    );
    expect(run.mock.calls.some((call) => call[0] === "npm")).toBe(false);
  });

  it.each([
    ["a feature branch", { branch: "feature/work" }, "follow main", false],
    ["a different GitHub remote", { remote: "https://github.com/someone/Orbit.git" }, "require origin", false]
  ] as const)("blocks %s", async (_caseName, overrides, message, fetchesMetadata) => {
    const { updater, run } = makeUpdater(overrides);

    const status = await updater.check();
    expect(status.state).toBe("blocked");
    expect(status.state === "blocked" ? status.message : "").toContain(message);
    expect(run.mock.calls.some((call) => call[1][0] === "fetch")).toBe(fetchesMetadata);
    expect(run.mock.calls.some((call) => call[1][0] === "merge")).toBe(false);
  });

  it("reports saved worktree changes and local commits without blocking the update check", async () => {
    const { updater } = makeUpdater({ changes: " M src/main/index.ts", counts: "2\t3" });

    await expect(updater.check()).resolves.toEqual({
      state: "available",
      branch: "main",
      currentCommit: current,
      latestCommit: latest,
      commitsBehind: 3,
      commitsAhead: 2,
      hasLocalChanges: true
    });
  });

  it("merges GitHub updates with local commits, installs dependencies, and rebuilds", async () => {
    const { updater, run, root } = makeUpdater();
    const progress: string[] = [];

    await expect(updater.update((message) => progress.push(message))).resolves.toEqual({
      ok: true,
      updated: true,
      currentCommit: current,
      latestCommit: latest,
      message: "Orbit now includes GitHub commit 2222222 and has been rebuilt."
    });

    const calls = run.mock.calls.map((call) => [call[0], ...call[1]]);
    expect(calls).toContainEqual(["git", "merge", "--no-edit", "refs/remotes/origin/main"]);
    expect(calls).toContainEqual(["npm", "install", "--no-audit", "--no-fund"]);
    expect(calls.some((call) => call[0] === "npm" && call[1] === "run" && call[2] === "build:compile" && call[3] === "--" && call[4] === "--outDir")).toBe(true);
    expect(readFileSync(path.join(root, "out", "main", "index.js"), "utf8")).toBe("updated build");
    expect(progress).toEqual([
      "Checking GitHub for updates…",
      "Checking the supported Node.js and npm versions…",
      "Combining GitHub updates with local commits…",
      "Installing app dependencies…",
      "Building the updated app in a staging directory…",
      "Checking and installing the staged build…"
    ]);
  });

  it("temporarily saves and restores worktree changes around the merge", async () => {
    const { updater, run } = makeUpdater({ changes: "M  src/main/index.ts\n?? scratch.txt" });
    const progress: string[] = [];

    await expect(updater.update((message) => progress.push(message))).resolves.toMatchObject({
      ok: true,
      updated: true,
      message: expect.stringContaining("Restored local file changes.")
    });

    const calls = run.mock.calls.map((call) => [call[0], ...call[1]]);
    expect(calls).toContainEqual(["git", "stash", "push", "--include-untracked", "--message", expect.any(String)]);
    expect(calls).toContainEqual(["git", "stash", "list", "--format=%gd %H"]);
    expect(calls).toContainEqual(["git", "stash", "apply", "--index", "stash@{0}"]);
    expect(calls).toContainEqual(["git", "stash", "drop", "stash@{0}"]);
    expect(progress).toContain("Saving local file changes for the update…");
    expect(progress).toContain("Restoring local file changes…");
  });

  it("reinstalls and rebuilds the current GitHub version when Update Orbit is explicitly requested", async () => {
    const { updater, run } = makeUpdater({ counts: "0\t0", latestCommit: current });
    const progress: string[] = [];

    await expect(updater.update((message) => progress.push(message))).resolves.toEqual({
      ok: true,
      updated: true,
      currentCommit: current,
      latestCommit: current,
      message: "Orbit is current at GitHub commit 1111111 and has been rebuilt."
    });

    const calls = run.mock.calls.map((call) => [call[0], ...call[1]]);
    expect(calls.some((call) => call[0] === "git" && call[1] === "merge")).toBe(false);
    expect(calls).toContainEqual(["npm", "install", "--no-audit", "--no-fund"]);
    expect(calls.some((call) => call[0] === "npm" && call[1] === "run" && call[2] === "build:compile" && call[3] === "--" && call[4] === "--outDir")).toBe(true);
    expect(progress).toEqual([
      "Checking GitHub for updates…",
      "Checking the supported Node.js and npm versions…",
      "GitHub is current; rebuilding this Orbit version…",
      "Installing app dependencies…",
      "Building the updated app in a staging directory…",
      "Checking and installing the staged build…"
    ]);
  });

  it("leaves the previous compiled app in place when the staged build fails", async () => {
    const { updater, root } = makeUpdater({ buildFailure: true });
    const result = await updater.update();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("synthetic build failure");
    expect(readFileSync(path.join(root, "out", "main", "index.js"), "utf8")).toBe("previous build");
  });

  it("refuses to modify the checkout when the selected Node version is unsupported", async () => {
    const { updater, run } = makeUpdater({ nodeVersion: "v22.22.0" });

    const result = await updater.update();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires Node.js 22.23.2");
    expect(run.mock.calls.some((call) => call[1][0] === "merge")).toBe(false);
    expect(run.mock.calls.some((call) => call[0] === "npm")).toBe(false);
  });
});
