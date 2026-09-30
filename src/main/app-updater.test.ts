import { describe, expect, it, vi } from "vitest";
import { createOrbitAppUpdater } from "./app-updater";

const root = "/repo/orbit";
const current = "1111111111111111111111111111111111111111";
const latest = "2222222222222222222222222222222222222222";

function makeUpdater(overrides: {
  branch?: string;
  remote?: string;
  changes?: string;
  counts?: string;
  nodeVersion?: string;
  fetchError?: Error;
  latestCommit?: string;
} = {}) {
  let merged = false;
  const githubCommit = overrides.latestCommit ?? latest;
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === "node") return overrides.nodeVersion ?? "v22.23.2";
    if (command === "npm") return "";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return root;
    if (args[0] === "remote") return overrides.remote ?? "https://github.com/Tsohnle95/Orbit.git";
    if (args[0] === "branch") return overrides.branch ?? "main";
    if (args[0] === "status") return overrides.changes ?? "";
    if (args[0] === "fetch") {
      if (overrides.fetchError) throw overrides.fetchError;
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return merged ? githubCommit : current;
    if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main") return githubCommit;
    if (args[0] === "rev-list") return overrides.counts ?? "0\t3";
    if (args[0] === "merge") {
      merged = true;
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
  return { updater: createOrbitAppUpdater(root, { run }), run };
}

describe("Orbit app updater", () => {
  it("checks GitHub main and reports the number of commits available", async () => {
    const { updater, run } = makeUpdater();

    await expect(updater.check()).resolves.toEqual({
      state: "available",
      branch: "main",
      currentCommit: current,
      latestCommit: latest,
      commitsBehind: 3
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
    ["a dirty checkout", { changes: " M src/main/index.ts" }, "local changes", false],
    ["a feature branch", { branch: "feature/work" }, "follow main", false],
    ["a different GitHub remote", { remote: "https://github.com/someone/Orbit.git" }, "require origin", false],
    ["local commits ahead of GitHub", { counts: "2\t3" }, "2 local commits", true]
  ] as const)("blocks %s", async (_caseName, overrides, message, fetchesMetadata) => {
    const { updater, run } = makeUpdater(overrides);

    const status = await updater.check();
    expect(status.state).toBe("blocked");
    expect(status.state === "blocked" ? status.message : "").toContain(message);
    expect(run.mock.calls.some((call) => call[1][0] === "fetch")).toBe(fetchesMetadata);
    expect(run.mock.calls.some((call) => call[1][0] === "merge")).toBe(false);
  });

  it("fast-forwards, installs dependencies, and rebuilds before reporting success", async () => {
    const { updater, run } = makeUpdater();
    const progress: string[] = [];

    await expect(updater.update((message) => progress.push(message))).resolves.toEqual({
      ok: true,
      updated: true,
      currentCommit: current,
      latestCommit: latest,
      message: "Orbit updated to 2222222 and rebuilt."
    });

    const calls = run.mock.calls.map((call) => [call[0], ...call[1]]);
    expect(calls).toContainEqual(["git", "merge", "--ff-only", "refs/remotes/origin/main"]);
    expect(calls).toContainEqual(["npm", "install", "--no-audit", "--no-fund"]);
    expect(calls).toContainEqual(["npm", "run", "build:compile"]);
    expect(progress).toEqual([
      "Checking GitHub for updates…",
      "Checking the supported Node.js and npm versions…",
      "Fast-forwarding Orbit to the latest GitHub commit…",
      "Installing app dependencies…",
      "Building the updated app…"
    ]);
  });

  it("reinstalls and rebuilds the current GitHub version when Update Orbit is explicitly requested", async () => {
    const { updater, run } = makeUpdater({ counts: "0\t0", latestCommit: current });
    const progress: string[] = [];

    await expect(updater.update((message) => progress.push(message))).resolves.toEqual({
      ok: true,
      updated: true,
      currentCommit: current,
      latestCommit: current,
      message: "Orbit is current at 1111111 and has been rebuilt."
    });

    const calls = run.mock.calls.map((call) => [call[0], ...call[1]]);
    expect(calls.some((call) => call[0] === "git" && call[1] === "merge")).toBe(false);
    expect(calls).toContainEqual(["npm", "install", "--no-audit", "--no-fund"]);
    expect(calls).toContainEqual(["npm", "run", "build:compile"]);
    expect(progress).toEqual([
      "Checking GitHub for updates…",
      "Checking the supported Node.js and npm versions…",
      "GitHub is current; rebuilding this Orbit version…",
      "Installing app dependencies…",
      "Building the updated app…"
    ]);
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
