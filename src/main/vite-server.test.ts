import { describe, expect, it, vi } from "vitest";
import { defaultViteDeps, viteHttpError, VitePreviewManager, type ViteChild, type ViteManagerDeps } from "./vite-server";

interface FakeChild extends ViteChild {
  killed: boolean;
  fireExit: () => void;
}

function fakeChild(): FakeChild {
  const listeners = new Map<string, Array<() => void>>();
  const child: FakeChild = {
    killed: false,
    fireExit: () => {
      for (const listener of listeners.get("exit") ?? []) listener();
    },
    kill: () => {
      child.killed = true;
    },
    diagnostics: () => "",
    once: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    }
  };
  return child;
}

function setup(deps?: Partial<ViteManagerDeps>): { manager: VitePreviewManager; deps: ViteManagerDeps; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const full: ViteManagerDeps = {
    launch: vi.fn((_directory: string, _port: number) => {
      const child = fakeChild();
      children.push(child);
      return child;
    }),
    findPort: vi.fn(async (first: number) => first),
    waitReady: vi.fn(async () => undefined),
    ...deps
  };
  return { manager: new VitePreviewManager(full), deps: full, children };
}

describe("VitePreviewManager", () => {
  it("starts a loopback server and reuses it for the same workspace directory", async () => {
    const { manager, deps, children } = setup();
    const first = await manager.start("ws-1", "/repo/a");
    expect(first).toEqual({ url: "http://127.0.0.1:5199/", port: 5199 });
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.launch).toHaveBeenCalledWith("/repo/a", 5199);

    const second = await manager.start("ws-1", "/repo/a");
    expect(second).toEqual(first);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
  });

  it("serves the active HTML file and safely encodes its URL", async () => {
    const { manager, deps } = setup();
    const preview = await manager.start("ws-1", "/repo/a", "pages/My demo.html");

    expect(preview).toEqual({ url: "http://127.0.0.1:5199/pages/My%20demo.html", port: 5199 });
    expect(deps.waitReady).toHaveBeenCalledWith(preview.url);
  });

  it("restarts the server when the workspace directory changes", async () => {
    const { manager, deps, children } = setup();
    await manager.start("ws-1", "/repo/a");
    await manager.start("ws-1", "/repo/b");
    expect(deps.launch).toHaveBeenCalledTimes(2);
    expect(children[0].killed).toBe(true);
    expect(children[1].killed).toBe(false);
  });

  it("stop kills the server and unknown keys are a no-op", async () => {
    const { manager, deps, children } = setup();
    manager.stop("missing");
    expect(deps.launch).not.toHaveBeenCalled();
    await manager.start("ws-1", "/repo/a");
    manager.stop("ws-1");
    expect(children[0].killed).toBe(true);
    expect(manager.running("ws-1")).toBeNull();
  });

  it("a failed readiness check stops the server and throws", async () => {
    const { manager, deps, children } = setup({
      waitReady: vi.fn(async () => {
        throw new Error("never ready");
      })
    });
    await expect(manager.start("ws-1", "/repo/a")).rejects.toThrow("never ready");
    expect(children[0].killed).toBe(true);
    expect(manager.running("ws-1")).toBeNull();
  });

  it("an early server exit cleans up and throws", async () => {
    let child!: FakeChild;
    const { manager } = setup({
      launch: vi.fn(() => {
        child = fakeChild();
        return child;
      }),
      waitReady: vi.fn(() => new Promise<void>(() => undefined))
    });
    const pending = manager.start("ws-1", "/repo/a");
    await Promise.resolve();
    child.fireExit();
    await expect(pending).rejects.toThrow("exited before becoming ready");
    expect(manager.running("ws-1")).toBeNull();
  });

  it("includes Vite stderr when startup fails", async () => {
    const child = fakeChild();
    child.diagnostics = () => "failed to load config: missing-plugin";
    const { manager } = setup({
      launch: vi.fn(() => child),
      waitReady: vi.fn(() => new Promise<void>(() => undefined))
    });
    const pending = manager.start("ws-1", "/repo/a");
    await Promise.resolve();
    child.fireExit();

    await expect(pending).rejects.toThrow("missing-plugin");
  });

  it("stopAll kills every running server", async () => {
    const { manager, children } = setup();
    await manager.start("ws-1", "/repo/a");
    await manager.start("ws-2", "/repo/b");
    await manager.stopAll();
    expect(children.map((child) => child.killed)).toEqual([true, true]);
    expect(manager.running("ws-1")).toBeNull();
    expect(manager.running("ws-2")).toBeNull();
  });
});

describe("viteHttpError", () => {
  it("accepts successful pages and rejects a false-ready 404 with guidance", () => {
    expect(viteHttpError("http://127.0.0.1:5199/demo.html", 200)).toBeNull();
    expect(viteHttpError("http://127.0.0.1:5199/", 404)?.message)
      .toContain("Open an HTML file and try again");
  });
});

describe("defaultViteDeps", () => {
  it("launches Vite as plain node without a second app instance", () => {
    const seen: Array<{ args: string[]; options: { cwd?: unknown; env?: NodeJS.ProcessEnv; stdio?: unknown } }> = [];
    const spawnImpl = ((...call: [string, string[], { cwd?: unknown; env?: NodeJS.ProcessEnv; stdio?: unknown }]) => {
      seen.push({ args: call[1], options: call[2] });
      return { ...fakeChild(), stderr: null };
    }) as unknown as Parameters<typeof defaultViteDeps>[2];
    const deps = defaultViteDeps("/repo/electron", ["/repo/node_modules/vite/bin/vite.js"], spawnImpl);
    deps.launch("/repo/a", 5199);
    expect(seen).toHaveLength(1);
    expect(seen[0].args).toEqual([
      "/repo/node_modules/vite/bin/vite.js",
      "serve",
      "/repo/a",
      "--port",
      "5199",
      "--strictPort",
      "--host",
      "127.0.0.1"
    ]);
    expect(seen[0].options.cwd).toBe("/repo/a");
    expect(seen[0].options.env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(seen[0].options.stdio).toEqual(["ignore", "ignore", "pipe"]);
  });
});
