// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SavedWorkspaceStore } from "./saved-workspaces";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; store: SavedWorkspaceStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "orbit-saved-workspaces-"));
  roots.push(root);
  return { root, store: new SavedWorkspaceStore(path.join(root, "settings", "workspaces.json")) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SavedWorkspaceStore", () => {
  it("returns an empty list only when neither the primary file nor backup exists", async () => {
    const { store } = await fixture();
    await expect(store.read()).resolves.toEqual([]);
    await expect(store.load()).resolves.toEqual({ workspaces: [], initialized: false });
  });

  it("atomically saves normalized workspaces and reads them after a new store is created", async () => {
    const { root, store } = await fixture();
    const values = [
      { directory: "/projects/orbit", name: "Orbit" },
      { directory: "/projects/orbit", name: "Duplicate" },
      { directory: "/projects/neptune", name: "" },
      { directory: "", name: "Invalid" }
    ];
    const expected = [
      { directory: "/projects/orbit", name: "Orbit" },
      { directory: "/projects/neptune", name: "neptune" }
    ];

    await expect(store.save(values)).resolves.toEqual(expected);
    await expect(new SavedWorkspaceStore(path.join(root, "settings", "workspaces.json")).read()).resolves.toEqual(expected);
    await expect(store.load()).resolves.toEqual({ workspaces: expected, initialized: true });
    expect(await readFile(path.join(root, "settings", "workspaces.json"), "utf8")).toContain('"version": 1');
  });

  it("recovers from a corrupt primary using the last known good backup", async () => {
    const { root, store } = await fixture();
    const file = path.join(root, "settings", "workspaces.json");
    const expected = [{ directory: "/projects/orbit", name: "Orbit" }];
    await store.save(expected);
    await store.save([...expected, { directory: "/projects/neptune", name: "Neptune" }]);
    await writeFile(file, "not json");

    await expect(store.read()).resolves.toEqual(expected);
  });

  it("refuses to overwrite when both the primary file and backup are corrupt", async () => {
    const { root, store } = await fixture();
    const file = path.join(root, "settings", "workspaces.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "broken primary");
    await writeFile(`${file}.bak`, "broken backup");

    await expect(store.read()).rejects.toThrow("Could not read saved workspaces");
    await expect(store.save([])).rejects.toThrow("without a readable current file or backup");
    await expect(readFile(file, "utf8")).resolves.toBe("broken primary");
  });

  it("serializes overlapping saves so the latest change wins", async () => {
    const { store } = await fixture();
    const first = store.save([{ directory: "/one", name: "One" }]);
    const second = store.save([{ directory: "/two", name: "Two" }]);
    await Promise.all([first, second]);
    await expect(store.read()).resolves.toEqual([{ directory: "/two", name: "Two" }]);
  });
});
