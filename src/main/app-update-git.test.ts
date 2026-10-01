import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrateGitHubSource } from "./app-update-git";

const roots: string[] = [];

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  }).trim();
}

function createRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orbit-update-merge-test-"));
  roots.push(root);
  const remote = path.join(root, "origin.git");
  const local = path.join(root, "local");
  const writer = path.join(root, "writer");
  mkdirSync(local);
  runGit(root, "init", "--bare", "--initial-branch=main", remote);
  runGit(local, "init", "--initial-branch=main");
  runGit(local, "config", "user.name", "Orbit Test");
  runGit(local, "config", "user.email", "orbit-test@example.invalid");
  for (const [name, contents] of Object.entries({
    "shared.txt": "base\n",
    "staged.txt": "base\n",
    "unstaged.txt": "base\n"
  })) writeFileSync(path.join(local, name), contents);
  runGit(local, "add", "-A");
  runGit(local, "commit", "-m", "base");
  runGit(local, "remote", "add", "origin", remote);
  runGit(local, "push", "-u", "origin", "main");
  runGit(root, "clone", remote, writer);
  runGit(writer, "config", "user.name", "Orbit Test");
  runGit(writer, "config", "user.email", "orbit-test@example.invalid");
  return { root, remote, local, writer };
}

function pushRemoteChange(writer: string, name: string, contents: string): string {
  writeFileSync(path.join(writer, name), contents);
  runGit(writer, "add", name);
  runGit(writer, "commit", "-m", `remote change ${name}`);
  runGit(writer, "push", "origin", "main");
  return runGit(writer, "rev-parse", "HEAD");
}

async function integrate(local: string, latestCommit: string, expectedHead: string): Promise<string> {
  return integrateGitHubSource(
    (args) => Promise.resolve(runGit(local, ...args)),
    { expectedHead, latestCommit, commitsBehind: 1 }
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub source integration for app updates", () => {
  it("merges remote and local commits while restoring staged, unstaged, and untracked files", async () => {
    const { local, writer } = createRepository();
    const remoteCommit = pushRemoteChange(writer, "remote.txt", "from GitHub\n");
    writeFileSync(path.join(local, "local.txt"), "local commit\n");
    runGit(local, "add", "local.txt");
    runGit(local, "commit", "-m", "local commit");
    const localCommit = runGit(local, "rev-parse", "HEAD");

    writeFileSync(path.join(local, "staged.txt"), "staged local edit\n");
    runGit(local, "add", "staged.txt");
    writeFileSync(path.join(local, "unstaged.txt"), "unstaged local edit\n");
    writeFileSync(path.join(local, "scratch.txt"), "untracked local file\n");
    runGit(local, "fetch", "origin", "main");

    const integrated = await integrate(local, remoteCommit, localCommit);

    expect(runGit(local, "merge-base", "--is-ancestor", localCommit, integrated)).toBe("");
    expect(runGit(local, "merge-base", "--is-ancestor", remoteCommit, integrated)).toBe("");
    expect(runGit(local, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(runGit(local, "diff", "--name-only")).toBe("unstaged.txt");
    expect(readFileSync(path.join(local, "scratch.txt"), "utf8")).toBe("untracked local file\n");
    expect(runGit(local, "stash", "list")).toBe("");
  });

  it("aborts a commit merge conflict and leaves the original branch untouched", async () => {
    const { local, writer } = createRepository();
    writeFileSync(path.join(local, "shared.txt"), "local committed version\n");
    runGit(local, "add", "shared.txt");
    runGit(local, "commit", "-m", "local conflicting change");
    const localCommit = runGit(local, "rev-parse", "HEAD");
    const remoteCommit = pushRemoteChange(writer, "shared.txt", "remote conflicting version\n");
    runGit(local, "fetch", "origin", "main");

    await expect(integrate(local, remoteCommit, localCommit)).rejects.toThrow("GitHub changes conflict with local commits: shared.txt");

    expect(runGit(local, "rev-parse", "HEAD")).toBe(localCommit);
    expect(readFileSync(path.join(local, "shared.txt"), "utf8")).toBe("local committed version\n");
    expect(runGit(local, "status", "--porcelain")).toBe("");
  });

  it("rolls back the merge when restoring saved files conflicts, then restores the user's edit", async () => {
    const { local, writer } = createRepository();
    const remoteCommit = pushRemoteChange(writer, "shared.txt", "remote committed version\n");
    const localCommit = runGit(local, "rev-parse", "HEAD");
    writeFileSync(path.join(local, "shared.txt"), "unfinished local version\n");
    runGit(local, "fetch", "origin", "main");

    await expect(integrate(local, remoteCommit, localCommit)).rejects.toThrow("saved local file changes: shared.txt");

    expect(runGit(local, "rev-parse", "HEAD")).toBe(localCommit);
    expect(readFileSync(path.join(local, "shared.txt"), "utf8")).toBe("unfinished local version\n");
    expect(runGit(local, "status", "--porcelain")).toContain("M shared.txt");
    expect(runGit(local, "stash", "list")).toBe("");
  });
});
