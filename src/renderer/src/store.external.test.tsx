import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellApi } from "../../preload";
import type { BackendMessage, ExternalOpenResult, SessionInfo } from "@shared/types";
import { StoreProvider, useStore } from "./store";

type Store = ReturnType<typeof useStore>;

let store: Store;
let messageHandler: ((message: BackendMessage) => void) | null;

function Probe(): ReactNode {
  store = useStore();
  return null;
}

function info(directory: string, generation: number): SessionInfo {
  return {
    id: `session-${generation}`,
    directory,
    workspace: { id: `${generation}1111111-1111-4111-8111-111111111111`, generation }
  };
}

function api(overrides: Partial<OpenShellApi> = {}): OpenShellApi {
  return {
    platform: "darwin",
    onMessage: (handler) => {
      messageHandler = handler;
      return () => { messageHandler = null; };
    },
    health: async () => true,
    takePendingPaths: async () => [],
    state: async () => null,
    activeSessions: async () => [],
    models: async () => [],
    modelDefault: async () => null,
    sessionSelection: async () => null,
    agents: async () => [],
    sessions: async () => [],
    openSession: async (directory, generation) => info(directory, generation),
    openSessionById: async (sessionID: string) => ({
      session: { ...info("/reopened", 0), id: sessionID },
      transcript: [],
      todos: [],
      usage: null
    }),
    closeSession: async () => {},
    readFile: async () => "content",
    listDir: async () => [],
    ...overrides
  } as OpenShellApi;
}

describe("store external files", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    messageHandler = null;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens an in-workspace drop as a normal relative tab", async () => {
    const openExternal = vi.fn(async (): Promise<ExternalOpenResult> => ({
      kind: "relative", rel: "src/a.txt", content: "hello"
    }));
    window.openshell = api({ openExternal });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openExternalPath("/one/src/a.txt"));

    expect(store.tabs.map((t) => t.path)).toEqual(["src/a.txt"]);
    expect(store.tabs[0].standalone).toBeUndefined();
    expect(openExternal).toHaveBeenCalledWith(store.session!.workspace, "/one/src/a.txt");
  });

  it("opens an out-of-workspace drop as a writable standalone tab", async () => {
    const openExternal = vi.fn(async (): Promise<ExternalOpenResult> => ({
      kind: "standalone", path: "/outside/notes.txt", content: "notes"
    }));
    window.openshell = api({ openExternal });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openExternalPath("/outside/notes.txt"));

    const tab = store.tabs.find((t) => t.path === "/outside/notes.txt")!;
    expect(tab.standalone).toBe(true);
    expect(store.activePath).toBe("/outside/notes.txt");
  });

  it("re-uses an already open standalone tab instead of duplicating it", async () => {
    const openExternal = vi.fn(async (): Promise<ExternalOpenResult> => ({
      kind: "standalone", path: "/outside/notes.txt", content: "notes"
    }));
    window.openshell = api({ openExternal });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openExternalPath("/outside/notes.txt"));
    await act(async () => store.openExternalPath("/outside/notes.txt"));

    expect(store.tabs.filter((t) => t.path === "/outside/notes.txt")).toHaveLength(1);
  });

  it("saves a standalone tab through the absolute write channel", async () => {
    const openExternal = vi.fn(async (): Promise<ExternalOpenResult> => ({
      kind: "standalone", path: "/outside/notes.txt", content: "v1"
    }));
    const writeStandalone = vi.fn(async () => {});
    window.openshell = api({ openExternal, writeStandalone });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openExternalPath("/outside/notes.txt"));
    act(() => store.editContent("/outside/notes.txt", "v2"));

    expect(writeStandalone).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.path === "/outside/notes.txt")?.dirty).toBe(true);
    expect(store.unsavedEditorFileCount).toBe(1);

    await act(async () => store.saveTab("/outside/notes.txt"));

    expect(writeStandalone).toHaveBeenCalledWith("/outside/notes.txt", "v2", "v1", false);
    const tab = store.tabs.find((t) => t.path === "/outside/notes.txt")!;
    expect(tab.dirty).toBe(false);
    expect(store.unsavedEditorFileCount).toBe(0);
  });

  it("keeps inactive-workspace dirty files in the close warning count", async () => {
    const openExternal = vi.fn(async (): Promise<ExternalOpenResult> => ({
      kind: "standalone", path: "/outside/notes.txt", content: "v1"
    }));
    window.openshell = api({ openExternal });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openExternalPath("/outside/notes.txt"));
    act(() => store.editContent("/outside/notes.txt", "unfinished"));
    expect(store.unsavedEditorFileCount).toBe(1);

    await act(async () => store.openSession("/two"));

    expect(store.session?.directory).toBe("/two");
    expect(store.unsavedEditorFileCount).toBe(1);
  });

  it("opens a single file as a single-file workspace and marks the sidebar", async () => {
    const init = info("/parent", 7);
    const openFileWorkspace = vi.fn(async () => ({ session: init, path: "index.html" }));
    window.openshell = api({ openFileWorkspace: openFileWorkspace as OpenShellApi["openFileWorkspace"] });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openFileWorkspace("/parent/index.html"));

    expect(store.session?.workspace.id).toBe(init.workspace.id);
    expect(store.singleFile).toBe("index.html");
    expect(store.tabs.map((t) => t.path)).toEqual(["index.html"]);
    expect(store.activePath).toBe("index.html");
  });

  it("imports dropped paths into a destination folder and refreshes the tree", async () => {
    const importExternal = vi.fn(async () => [
      { name: "a.txt", rel: "vendor/a.txt", imported: true }
    ]);
    const listDir = vi.fn(async () => []);
    window.openshell = api({ importExternal, listDir });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.importPaths("vendor", ["/outside/a.txt"]));

    expect(importExternal).toHaveBeenCalledWith(store.session!.workspace, "vendor", ["/outside/a.txt"]);
    expect(listDir).toHaveBeenCalled();
  });

  it("imports dropped files and folders into the workspace root", async () => {
    const importExternal = vi.fn(async () => [
      { name: "folder", rel: "folder", imported: true },
      { name: "a.txt", rel: "a.txt", imported: true }
    ]);
    const listDir = vi.fn(async () => []);
    window.openshell = api({ importExternal, listDir });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.dropIntoExplorer(["/outside/folder", "/outside/a.txt"]));

    expect(importExternal).toHaveBeenCalledWith(store.session!.workspace, "", ["/outside/folder", "/outside/a.txt"]);
  });
});
