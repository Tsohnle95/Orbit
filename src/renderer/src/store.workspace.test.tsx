import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellApi } from "../../preload";
import type { BackendMessage, RecoveryRecord, RuntimeID, SessionInfo } from "@shared/types";
import { StoreProvider, useStore } from "./store";

type Store = ReturnType<typeof useStore>;

let store: Store;
let messageHandler: ((message: BackendMessage) => void) | null;

function Probe(): ReactNode {
  store = useStore();
  return null;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((done) => { resolve = done as (value?: T) => void; });
  return { promise, resolve };
}

function info(directory: string, generation: number, runtimeID?: RuntimeID): SessionInfo {
  return {
    id: `session-${generation}`,
    ...(runtimeID ? { runtimeID } : {}),
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
    detachPath: async () => {},
    ...overrides
  } as OpenShellApi;
}

describe("store workspace continuations", () => {
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

  it("keeps removed paths session-only so reloads enumerate the workspace again", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    act(() => store.removeFromWorkspace("folder"));

    expect(store.hiddenPaths).toEqual(new Set(["folder"]));

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));

    expect(store.hiddenPaths).toEqual(new Set());
  });

  it("silently unhides an exact existing path when it is dropped back", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    act(() => store.removeFromWorkspace("folder"));
    window.openshell = api({
      importExternal: async () => [{ name: "folder", rel: "folder", imported: false, reason: "already in the workspace" }]
    });

    await act(async () => store.importPaths("", ["/one/folder"]));

    expect(store.hiddenPaths).toEqual(new Set());
  });

  it("does not apply a completed delete to tabs opened in a newer workspace", async () => {
    const deletion = deferred();
    window.openshell = api({ deletePath: vi.fn(() => deletion.promise) });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("same.txt"));
    let pending!: Promise<void>;
    await act(async () => { pending = store.deleteEntry("same.txt"); });
    await act(async () => store.openSession("/two"));
    await act(async () => store.openFile("same.txt"));
    await act(async () => deletion.resolve());
    await act(async () => pending);

    expect(store.session?.directory).toBe("/two");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["same.txt"]);
  });

  it("reveals a path without changing the active editor state and handles stale items", async () => {
    const revealInFileManager = vi.fn(async () => { throw new Error("workspace item is no longer available"); });
    window.openshell = api({ revealInFileManager });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("same.txt"));
    const tabsBefore = store.tabs;
    const activeBefore = store.activePath;

    await act(async () => store.revealInFileManager("same.txt"));

    expect(revealInFileManager).toHaveBeenCalledWith(store.session!.workspace, "same.txt");
    expect(store.tabs).toBe(tabsBefore);
    expect(store.activePath).toBe(activeBefore);
    expect(store.toasts.at(-1)?.text).toBe("workspace item is no longer available");
  });

  it("does not open a file created by a completed old-workspace operation", async () => {
    const creation = deferred();
    window.openshell = api({ createFile: vi.fn(() => creation.promise) });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    act(() => store.startCreate("", "file"));
    let pending!: Promise<void>;
    await act(async () => { pending = store.commitName("old.txt"); });
    await act(async () => store.openSession("/two"));
    await act(async () => creation.resolve());
    await act(async () => pending);

    expect(store.session?.directory).toBe("/two");
    expect(store.tabs).toEqual([]);
  });

  it("does not apply a completed rename to tabs opened in a newer workspace", async () => {
    const rename = deferred();
    window.openshell = api({ renamePath: vi.fn(() => rename.promise) });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("same.txt"));
    act(() => store.startRename("same.txt"));
    let pending!: Promise<void>;
    await act(async () => { pending = store.commitName("renamed.txt"); });
    await act(async () => store.openSession("/two"));
    await act(async () => store.openFile("same.txt"));
    await act(async () => rename.resolve());
    await act(async () => pending);

    expect(store.session?.directory).toBe("/two");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["same.txt"]);
  });

  it("remaps tabs, active path, and tracked changes on moveEntry and refreshes both parents", async () => {
    const movePath = vi.fn(async () => {});
    const listDir = vi.fn(async () => []);
    window.openshell = api({ movePath, listDir });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("src/a.txt"));
    await act(async () => {
      messageHandler!({
        kind: "file-update",
        file: {
          workspace: store.session!.workspace,
          sessionID: store.session!.id,
          path: "src/a.txt",
          baseline: { kind: "known", content: "old" },
          content: "new",
          deleted: false
        }
      });
    });
    await act(async () => { await store.moveEntry("src", "lib"); });

    expect(movePath).toHaveBeenCalledWith(store.session!.workspace, "src", "lib");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["lib/src/a.txt"]);
    expect(store.activePath).toBe("lib/src/a.txt");
    expect(store.agentFiles.get("lib/src/a.txt")).toEqual({
      baseline: { kind: "known", content: "old" },
      content: "new",
      deleted: false
    });
    expect(store.agentFiles.has("src/a.txt")).toBe(false);
    expect(listDir).toHaveBeenCalledWith(store.session!.workspace, "");
    expect(listDir).toHaveBeenCalledWith(store.session!.workspace, "lib");
  });

  it("follows a correlated external rename for an open editor tab", async () => {
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("src/old.txt"));
    const workspace = store.session!.workspace;

    await act(async () => {
      messageHandler!({
        kind: "file-update",
        file: {
          workspace,
          sessionID: store.session!.id,
          path: "src/old.txt",
          baseline: { kind: "known", content: "content" },
          content: null,
          deleted: true
        }
      });
      messageHandler!({
        kind: "file-update",
        file: {
          workspace,
          sessionID: store.session!.id,
          path: "lib/new.txt",
          movedFrom: "src/old.txt",
          baseline: { kind: "known", content: "", exists: false },
          content: "content",
          deleted: false
        }
      });
    });

    expect(store.tabs).toEqual([
      expect.objectContaining({ path: "lib/new.txt", name: "new.txt", content: "content", deleted: false })
    ]);
    expect(store.activePath).toBe("lib/new.txt");
    expect(store.agentFiles.get("src/old.txt")).toEqual({
      baseline: { kind: "known", content: "content" },
      content: null,
      deleted: true
    });
    expect(store.agentFiles.get("lib/new.txt")).toEqual({
      baseline: { kind: "known", content: "", exists: false },
      content: "content",
      deleted: false
    });
  });

  it("removes restored files and created-then-deleted files while retaining deleted tracked files", async () => {
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    const workspace = store.session!.workspace;
    await act(async () => messageHandler!({
      kind: "file-update",
      file: { workspace, sessionID: store.session!.id, path: "restored.txt", baseline: { kind: "known", content: "old" }, content: "new", deleted: false }
    }));
    await act(async () => messageHandler!({
      kind: "file-update",
      file: { workspace, sessionID: store.session!.id, path: "empty.txt", baseline: { kind: "known", content: "" }, content: null, deleted: true }
    }));
    expect(store.agentFiles.has("restored.txt")).toBe(true);
    expect(store.agentFiles.has("empty.txt")).toBe(true);

    await act(async () => {
      messageHandler!({
        kind: "file-update",
        file: { workspace, sessionID: store.session!.id, path: "restored.txt", baseline: { kind: "known", content: "old" }, content: "old", deleted: false }
      });
    });

    expect(store.agentFiles.has("restored.txt")).toBe(false);
    expect(store.agentFiles.has("empty.txt")).toBe(true);

    await act(async () => messageHandler!({
      kind: "file-update",
      file: { workspace, sessionID: store.session!.id, path: "created.txt", baseline: { kind: "known", content: "", exists: false }, content: null, deleted: true }
    }));
    expect(store.agentFiles.has("created.txt")).toBe(false);

    await act(async () => messageHandler!({
      kind: "file-update",
      file: { workspace, sessionID: store.session!.id, path: "empty.txt", baseline: { kind: "known", content: "", exists: false }, content: null, deleted: true }
    }));
    expect(store.agentFiles.has("empty.txt")).toBe(false);
  });

  it("drops deleted change entries instead of remapping them to the destination", async () => {
    window.openshell = api({ movePath: vi.fn(async () => {}) });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => {
      messageHandler!({
        kind: "file-update",
        file: {
          workspace: store.session!.workspace,
          sessionID: store.session!.id,
          path: "folder",
          baseline: { kind: "unknown" },
          content: null,
          deleted: true
        }
      });
      messageHandler!({
        kind: "file-update",
        file: {
          workspace: store.session!.workspace,
          sessionID: store.session!.id,
          path: "folder/child.txt",
          baseline: { kind: "known", content: "old" },
          content: "new",
          deleted: false
        }
      });
    });
    await act(async () => { await store.moveEntry("folder", "dest"); });

    expect(store.agentFiles.has("folder")).toBe(false);
    expect(store.agentFiles.has("folder/child.txt")).toBe(false);
    expect(store.agentFiles.get("dest/folder/child.txt")).toEqual({
      baseline: { kind: "known", content: "old" },
      content: "new",
      deleted: false
    });
  });

  it("does not remap tabs for a move that completes in a newer workspace", async () => {
    const move = deferred();
    window.openshell = api({ movePath: vi.fn(() => move.promise) });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("same.txt"));
    let pending!: Promise<void>;
    await act(async () => { pending = store.moveEntry("same.txt", "sub"); });
    await act(async () => store.openSession("/two"));
    await act(async () => store.openFile("same.txt"));
    await act(async () => move.resolve());
    await act(async () => pending);

    expect(store.session?.directory).toBe("/two");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["same.txt"]);
  });

  it("does not let startup restoration steal focus from a user activation", async () => {
    const startup = deferred<SessionInfo[]>();
    const openSessionById = vi.fn(async () => ({
      session: info("/restored", 2),
      transcript: [],
      todos: [],
      usage: null
    }));
    window.openshell = api({ activeSessions: () => startup.promise, openSessionById });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/chosen"));
    await act(async () => startup.resolve([info("/restored", 2)]));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(openSessionById).toHaveBeenCalledWith("session-2", expect.any(Number));
    expect(store.panels.map((panel) => panel.directory).sort()).toEqual(["/chosen", "/restored"]);
    expect(store.session?.directory).toBe("/chosen");
  });

  it("starts on the Welcome screen after a process restart instead of reopening past sessions", async () => {
    const openSession = vi.fn(async (directory: string, generation: number) => ({
      ...info(directory, generation, directory === "/one" ? "deepseek" : "opencode"),
      id: directory === "/one" ? "session-one" : "session-two"
    }));
    window.openshell = api({ openSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/two"));
    await act(async () => store.focusSession("session-one"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(store.panels.map((panel) => panel.id)).toEqual(["session-one", "session-two"]);

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const openSessionById = vi.fn();
    window.openshell = api({ activeSessions: async () => [], openSessionById });

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(openSessionById).not.toHaveBeenCalled();
    expect(store.panels).toEqual([]);
    expect(store.session).toBeNull();
  });

  it("re-attaches live backend sessions on startup and drops stale persisted layout", async () => {
    window.localStorage.setItem("orbit.sessionLayout", JSON.stringify({
      version: 1,
      panels: [{ sessionID: "stale", runtimeID: "opencode" }],
      activeSessionID: "stale"
    }));
    const openSessionById = vi.fn(async (sessionID: string, generation: number, runtimeID?: RuntimeID) => ({
      session: { ...info("/live", generation, runtimeID), id: sessionID },
      transcript: [],
      todos: [],
      usage: null
    }));
    window.openshell = api({
      activeSessions: async () => [info("/live", 7, "deepseek")],
      openSessionById
    });

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(openSessionById.mock.calls.map((call) => call[0])).toEqual(["session-7"]);
    expect(openSessionById.mock.calls.map((call) => call[2])).toEqual([undefined]);
    expect(store.panels.map((panel) => panel.id)).toEqual(["session-7"]);
    expect(store.session?.id).toBe("session-7");
    expect(window.localStorage.getItem("orbit.sessionLayout")).toBeNull();
  });

  it("waits for backend readiness before re-attaching live sessions", async () => {
    const health = deferred<boolean>();
    const openSessionById = vi.fn(async (sessionID: string, generation: number, runtimeID?: RuntimeID) => ({
      session: { ...info("/one", generation, runtimeID), id: sessionID },
      transcript: [],
      todos: [],
      usage: null
    }));
    window.openshell = api({
      health: () => health.promise,
      activeSessions: async () => [info("/one", 1, "opencode")],
      openSessionById
    });

    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(openSessionById).not.toHaveBeenCalled();
    expect(store.panels).toEqual([]);

    await act(async () => health.resolve(true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(openSessionById).toHaveBeenCalledWith("session-1", expect.any(Number));
    expect(store.session?.id).toBe("session-1");
  });

  it("opens parallel sessions and restores each session's own tabs when focus swaps", async () => {
    window.openshell = api({
      openSession: async (directory: string, generation: number) => info(directory, generation),
      readFile: async (_workspace: unknown, path: string) => `content of ${path}`
    });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.openFile("one.txt"));
    await act(async () => store.addModelPanel("/two"));
    await act(async () => store.openFile("two.txt"));

    expect(store.panels).toHaveLength(2);
    expect(store.session?.directory).toBe("/two");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["two.txt"]);

    await act(async () => store.focusSession(store.panels[0].id));
    expect(store.session?.directory).toBe("/one");
    expect(store.tabs.map((tab) => tab.path)).toEqual(["one.txt"]);

    await act(async () => store.focusSession(store.panels[1].id));
    expect(store.tabs.map((tab) => tab.path)).toEqual(["two.txt"]);
  });

  it("reopens an already-open session by focusing its panel and hydrating a missing transcript", async () => {
    const openSessionById = vi.fn(async (sessionID: string) => ({
      session: { ...info("/reopened", 0), id: sessionID },
      transcript: [],
      todos: [],
      usage: null
    }));
    window.openshell = api({ openSessionById });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/two"));
    expect(store.panels).toHaveLength(2);
    const first = store.panels[0];

    await act(async () => store.reopenSession(first.id));

    expect(openSessionById).toHaveBeenCalledWith(first.id, expect.any(Number));
    expect(store.panels).toHaveLength(2);
    expect(store.session?.id).toBe(first.id);
  });

  it("reopens a session in the selected panel while detaching its predecessor into Open now", async () => {
    const closeSession = vi.fn(async () => {});
    const openSessionById = vi.fn(async (sessionID: string) => ({
      session: { ...info("/neptune-ai", 9), id: sessionID },
      transcript: [],
      todos: [],
      usage: null
    }));
    window.openshell = api({ closeSession, openSessionById });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/luno"));
    await act(async () => store.addModelPanel("/orbit"));
    const previousSelected = store.panels[1];

    await act(async () => store.reopenSession("session-neptune"));

    expect(store.panels.map((panel) => panel.directory)).toEqual(["/luno", "/neptune-ai"]);
    expect(store.session?.directory).toBe("/neptune-ai");
    expect(closeSession).not.toHaveBeenCalled();
    expect(store.activeSessions.map((active) => active.id)).toContain(previousSelected.id);
    expect(store.activeSessions.map((active) => active.id)).toContain("session-neptune");
  });

  it("updates a repeated session event in place without duplicating its panel", async () => {
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/luno"));
    await act(async () => store.addModelPanel("/orbit"));
    const first = store.panels[0];
    const refreshed = {
      ...first,
      directory: "/luno-renamed",
      workspace: { id: "refreshed-workspace", generation: 20 }
    };

    await act(async () => messageHandler!({ kind: "session", session: refreshed }));

    expect(store.panels.map((panel) => panel.id)).toEqual([first.id, store.panels[1].id]);
    expect(store.panels.map((panel) => panel.directory)).toEqual(["/luno-renamed", "/orbit"]);
  });

  it("closes a panel, tears down its backend context, and keeps the neighbor focused", async () => {
    const closeSession = vi.fn(async () => {});
    window.openshell = api({ closeSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/two"));
    expect(store.session?.id).toBe(store.panels[1].id);
    const closedWorkspace = store.panels[1].workspace;

    await act(async () => store.closePanel(store.panels[1].id));
    expect(closeSession).toHaveBeenCalledWith(closedWorkspace);
    expect(store.panels.map((panel) => panel.id)).toEqual([store.panels[0].id]);
    expect(store.session?.id).toBe(store.panels[0].id);
    const lastWorkspace = store.panels[0].workspace;

    await act(async () => store.closePanel(store.panels[0].id));
    expect(closeSession).toHaveBeenCalledWith(lastWorkspace);
    expect(store.panels).toHaveLength(0);
    expect(store.session).toBeNull();
  });

  it("does not apply an older reopen completion after a newer reopen", async () => {
    const older = deferred<Awaited<ReturnType<NonNullable<OpenShellApi["openSessionById"]>>>>();
    const newer = deferred<Awaited<ReturnType<NonNullable<OpenShellApi["openSessionById"]>>>>();
    const openSessionById = vi.fn((id: string) => id === "older" ? older.promise : newer.promise);
    const closeSession = vi.fn(async () => {});
    window.openshell = api({ openSessionById, closeSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    let olderPending!: Promise<SessionInfo | null>;
    let newerPending!: Promise<SessionInfo | null>;
    await act(async () => { olderPending = store.reopenSession("older"); });
    await act(async () => { newerPending = store.reopenSession("newer"); });
    await act(async () => newer.resolve({ session: info("/newer", 2), transcript: [], todos: [], usage: null }));
    await act(async () => newerPending);
    await act(async () => older.resolve({ session: info("/older", 1), transcript: [], todos: [], usage: null }));
    await act(async () => olderPending);

    expect(store.session?.directory).toBe("/newer");
    expect(closeSession).toHaveBeenCalledWith(info("/older", 1).workspace);
  });

  it("replaces the displayed session and detaches every old session into Open now", async () => {
    const closeSession = vi.fn(async () => {});
    window.openshell = api({ closeSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/two"));
    const oldIDs = store.panels.map((panel) => panel.id);

    await act(async () => store.openSession("/three"));

    expect(store.panels).toHaveLength(1);
    expect(store.session?.directory).toBe("/three");
    expect(closeSession).not.toHaveBeenCalled();
    for (const id of [...oldIDs, store.session!.id]) {
      expect(store.activeSessions.map((active) => active.id)).toContain(id);
    }
  });

  it("keeps explicit model-panel additions separate from workspace replacement", async () => {
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/one"));

    expect(store.panels).toHaveLength(2);
    expect(store.panels.every((panel) => panel.directory === "/one")).toBe(true);
  });

  it("replaces panels when the folder picker completes", async () => {
    const closeSession = vi.fn(async () => {});
    window.openshell = api({
      closeSession,
      selectFolder: vi.fn(async () => info("/picked", 99))
    });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => store.addModelPanel("/two"));
    const oldIDs = store.panels.map((panel) => panel.id);

    await act(async () => store.selectFolder());

    expect(store.panels).toHaveLength(1);
    expect(store.session?.directory).toBe("/picked");
    expect(closeSession).not.toHaveBeenCalled();
    for (const id of [...oldIDs, store.session!.id]) {
      expect(store.activeSessions.map((active) => active.id)).toContain(id);
    }
  });

  it("closes a stale replacement context instead of reattaching it", async () => {
    const older = deferred<SessionInfo>();
    const newer = deferred<SessionInfo>();
    const closeSession = vi.fn(async () => {});
    const openSession = vi.fn((directory: string) => directory === "/older" ? older.promise : newer.promise);
    window.openshell = api({ openSession, closeSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    let olderPending!: Promise<SessionInfo | null>;
    let newerPending!: Promise<SessionInfo | null>;
    await act(async () => { olderPending = store.openSession("/older"); });
    await act(async () => { newerPending = store.openSession("/newer"); });
    await act(async () => newer.resolve(info("/newer", 2)));
    await act(async () => newerPending);
    await act(async () => older.resolve(info("/older", 1)));
    await act(async () => olderPending);

    expect(store.session?.directory).toBe("/newer");
    expect(store.panels.map((panel) => panel.directory)).toEqual(["/newer"]);
    expect(closeSession).toHaveBeenCalledWith(info("/older", 1).workspace);
  });

  it("closes additive contexts that finish after a workspace replacement", async () => {
    const first = deferred<SessionInfo>();
    const second = deferred<SessionInfo>();
    const closeSession = vi.fn(async () => {});
    const openSession = vi.fn((directory: string) => {
      if (directory === "/first") return first.promise;
      if (directory === "/second") return second.promise;
      return Promise.resolve(info(directory, 3));
    });
    window.openshell = api({ openSession, closeSession });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));

    let firstPending!: Promise<void>;
    let secondPending!: Promise<void>;
    await act(async () => { firstPending = store.addModelPanel("/first"); });
    await act(async () => { secondPending = store.addModelPanel("/second"); });
    await act(async () => store.openSession("/replacement"));
    await act(async () => first.resolve(info("/first", 1)));
    await act(async () => second.resolve(info("/second", 2)));
    await act(async () => firstPending);
    await act(async () => secondPending);

    expect(store.panels.map((panel) => panel.directory)).toEqual(["/replacement"]);
    expect(store.session?.directory).toBe("/replacement");
    expect(closeSession).toHaveBeenCalledWith(info("/first", 1).workspace);
    expect(closeSession).toHaveBeenCalledWith(info("/second", 2).workspace);
  });

  it("loads, opens, acknowledges, and identity-gates recovery records", async () => {
    const record: RecoveryRecord = {
      id: "1786533818724-e85066e0-7d22-4d91-b476-ba097731f371:original",
      artifact: "original",
      originalPath: "save.txt",
      recoveryPath: ".openshell-recovery/id/original",
      createdAt: 1,
      acknowledged: false,
      reason: "saved"
    };
    const recoveryRecords = vi.fn(async () => [record]);
    const openRecovery = vi.fn(async () => {});
    const acknowledgeRecovery = vi.fn(async () => {});
    window.openshell = api({ recoveryRecords, openRecovery, acknowledgeRecovery });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));

    expect(store.recoveryRecords).toEqual([record]);
    await act(async () => store.openRecovery(record.id));
    await act(async () => store.acknowledgeRecovery(record.id));
    expect(openRecovery).toHaveBeenCalledWith(store.session!.workspace, record.id);
    expect(acknowledgeRecovery).toHaveBeenCalledWith(store.session!.workspace, record.id);
  });

  it("ensureRootOpen refreshes an already-expanded root instead of collapsing it", async () => {
    const listDir = vi.fn(async () => [{ path: "alpha", type: "directory" as const }]);
    window.openshell = api({ listDir });
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));

    await act(async () => { await store.ensureRootOpen(); });
    expect(store.expanded.has("")).toBe(true);
    expect(listDir).toHaveBeenCalledTimes(1);

    listDir.mockClear();
    await act(async () => { await store.ensureRootOpen(); });

    expect(store.expanded.has("")).toBe(true);
    expect(listDir).toHaveBeenCalledTimes(1);
    expect(store.tree[""]).toHaveLength(1);
  });

  it("restores a nested workspace path when its workspace panel closes", async () => {
    window.openshell = api();
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/parent"));
    await act(async () => store.addModelPanel("/parent/child"));

    const child = store.panels.find((panel) => panel.directory === "/parent/child")!;
    await act(async () => store.closePanel(child.id));

    expect(store.session?.directory).toBe("/parent");
    expect(store.hiddenPaths).toEqual(new Set());
  });
});
