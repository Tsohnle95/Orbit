import { randomUUID } from "node:crypto";

type GitCommand = (args: string[]) => Promise<string>;

export interface IntegrateGitHubSourceOptions {
  expectedHead: string;
  latestCommit: string;
  commitsBehind: number;
  onProgress?: (message: string) => void;
}

function pathsFromGit(value: string): string[] {
  return [...new Set(value.split("\0").filter(Boolean))].slice(0, 12);
}

function formatPaths(paths: string[]): string {
  return paths.length > 0 ? `: ${paths.join(", ")}${paths.length === 12 ? ", and more" : ""}` : "";
}

export async function integrateGitHubSource(
  git: GitCommand,
  { expectedHead, latestCommit, commitsBehind, onProgress }: IntegrateGitHubSourceOptions
): Promise<string> {
  const branch = await git(["branch", "--show-current"]);
  const currentHead = await git(["rev-parse", "HEAD"]);
  if (branch !== "main" || currentHead !== expectedHead) {
    throw new Error("This Orbit checkout changed while checking for updates. Review the branch, then check again.");
  }

  const remoteHead = await git(["rev-parse", "refs/remotes/origin/main"]);
  if (remoteHead !== latestCommit) {
    throw new Error("GitHub main changed while Orbit was checking. Check for updates and try again.");
  }

  const initialHead = currentHead;
  const backupRef = `refs/orbit/update-backup/${randomUUID()}`;
  await git(["update-ref", backupRef, initialHead]);

  let stashCommit: string | null = null;
  let integratedHead = initialHead;
  let mergeStarted = false;
  let conflictPaths: string[] = [];
  let failureKind: "merge" | "restore" | null = null;

  const readStashHead = async (): Promise<string | null> => {
    try {
      return (await git(["rev-parse", "--verify", "--quiet", "refs/stash"])).trim() || null;
    } catch {
      return null;
    }
  };
  const readStashRef = async (commit: string): Promise<string> => {
    const entries = await git(["stash", "list", "--format=%gd %H"]);
    for (const entry of entries.split(/\r?\n/)) {
      const [reference, hash] = entry.trim().split(/\s+/, 2);
      if (hash === commit) return reference;
    }
    throw new Error("The saved local file changes are no longer in Git's stash list.");
  };
  const readUnmergedPaths = async (): Promise<string[]> => {
    try {
      return pathsFromGit(await git(["diff", "--name-only", "--diff-filter=U", "-z"]));
    } catch {
      return [];
    }
  };
  const deleteBackupRef = async (): Promise<void> => {
    await git(["update-ref", "-d", backupRef, initialHead]).catch(() => {});
  };
  const restoreStash = async (): Promise<void> => {
    if (!stashCommit) return;
    const commit = stashCommit;
    const reference = await readStashRef(stashCommit);
    await git(["stash", "apply", "--index", reference]);
    stashCommit = null;
    const dropReference = await readStashRef(commit).catch(() => null);
    if (dropReference) await git(["stash", "drop", dropReference]).catch(() => {});
  };

  try {
    const changes = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (changes.trim()) {
      onProgress?.("Saving local file changes for the update…");
      const previousStash = await readStashHead();
      try {
        await git(["stash", "push", "--include-untracked", "--message", `Orbit update ${randomUUID()}`]);
      } catch (error) {
        const possibleStash = await readStashHead();
        if (possibleStash && possibleStash !== previousStash) stashCommit = possibleStash;
        throw error;
      }
      const nextStash = await readStashHead();
      if (!nextStash || nextStash === previousStash) {
        throw new Error("Orbit could not safely save the local file changes. No source update was applied.");
      }
      stashCommit = nextStash;
      const remainingChanges = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (remainingChanges.trim()) {
        throw new Error("Orbit could not safely set aside every local change. No source update was applied.");
      }
    }

    if (commitsBehind > 0) {
      onProgress?.("Combining GitHub updates with local commits…");
      mergeStarted = true;
      try {
        await git(["merge", "--no-edit", "refs/remotes/origin/main"]);
      } catch (error) {
        integratedHead = await git(["rev-parse", "HEAD"]).catch(() => integratedHead);
        conflictPaths = await readUnmergedPaths();
        failureKind = "merge";
        throw error;
      }
      mergeStarted = false;
      integratedHead = await git(["rev-parse", "HEAD"]);
      await git(["merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD"]);
    }

    if (stashCommit) {
      onProgress?.("Restoring local file changes…");
      try {
        await restoreStash();
      } catch (error) {
        conflictPaths = await readUnmergedPaths();
        failureKind = "restore";
        throw error;
      }
    }

    integratedHead = await git(["rev-parse", "HEAD"]);
    await deleteBackupRef();
    return integratedHead;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (mergeStarted) await git(["merge", "--abort"]).catch(() => {});

    let observedHead = await git(["rev-parse", "HEAD"]).catch(() => "");
    let recoveryError: unknown = null;
    if (observedHead === integratedHead && integratedHead !== initialHead) {
      try {
        await git(["reset", "--hard", initialHead]);
        observedHead = initialHead;
        integratedHead = initialHead;
      } catch (resetError) {
        recoveryError = resetError;
      }
    }

    if (stashCommit && observedHead === initialHead) {
      try {
        await restoreStash();
      } catch (restoreError) {
        recoveryError = restoreError;
      }
    } else if (stashCommit && observedHead !== initialHead) {
      recoveryError ??= new Error("Orbit could not safely return to the original branch state.");
    }

    if (!recoveryError && !stashCommit && (observedHead === initialHead || observedHead === integratedHead)) {
      await deleteBackupRef();
    }

    const paths = formatPaths(conflictPaths);
    if (recoveryError) {
      const stash = stashCommit ? ` The original worktree is preserved in updater stash ${stashCommit.slice(0, 10)}.` : "";
      throw new Error(`Orbit could not finish the update safely. ${detail}${stash} The original commit is retained at ${backupRef}. Recovery details: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
    if (failureKind === "merge") {
      throw new Error(`GitHub changes conflict with local commits${paths}. Orbit aborted the merge and restored local file changes. Resolve the conflict, then retry.`);
    }
    if (failureKind === "restore") {
      throw new Error(`The GitHub update conflicts with saved local file changes${paths}. Orbit rolled back the update and restored the local files.`);
    }
    throw new Error(detail);
  }
}
