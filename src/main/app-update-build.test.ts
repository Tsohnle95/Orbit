// @vitest-environment node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagingOutputName, swapBuiltOutput } from "./app-update-build";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "orbit-update-build-"));
  roots.push(root);
  return root;
}

async function writeBuild(root: string, output: string, marker: string): Promise<void> {
  await Promise.all(["main/index.js", "preload/index.js", "renderer/index.html"].map(async (relative) => {
    const target = path.join(root, output, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, marker);
  }));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("staged Orbit builds", () => {
  it("replaces the live output only after all staged entry points exist", async () => {
    const root = await fixture();
    const stage = stagingOutputName();
    await writeBuild(root, "out", "previous");
    await writeBuild(root, stage, "updated");

    await swapBuiltOutput(root, stage);

    await expect(readFile(path.join(root, "out/main/index.js"), "utf8")).resolves.toBe("updated");
    await expect(access(path.join(root, stage))).rejects.toThrow();
  });

  it("keeps the previous output when the staged build is incomplete", async () => {
    const root = await fixture();
    const stage = stagingOutputName();
    await writeBuild(root, "out", "previous");
    await mkdir(path.join(root, stage, "main"), { recursive: true });
    await writeFile(path.join(root, stage, "main/index.js"), "partial");

    await expect(swapBuiltOutput(root, stage)).rejects.toThrow("staged build is incomplete");
    await expect(readFile(path.join(root, "out/main/index.js"), "utf8")).resolves.toBe("previous");
  });

  it("rejects paths outside the generated staging directory convention", async () => {
    const root = await fixture();
    await expect(swapBuiltOutput(root, "out")).rejects.toThrow("invalid name");
  });
});
