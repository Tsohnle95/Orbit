import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellApi } from "../../preload";
import type { BackendMessage, SessionInfo } from "@shared/types";
import { StoreProvider, useStore } from "./store";

let store: ReturnType<typeof useStore>;
let receive: (message: BackendMessage) => void;
function Probe() { store = useStore(); return null; }
function info(directory: string, generation: number, id = `session-${generation}`): SessionInfo {
  return { id, directory, workspace: { id: `${generation}1111111-1111-4111-8111-111111111111`, generation } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function api(overrides: Partial<OpenShellApi> = {}): OpenShellApi {
  return {
    platform: "darwin", onMessage: (handler) => { receive = handler; return () => {}; },
    health: async () => true, takePendingPaths: async () => [], state: async () => null,
    activeSessions: async () => [], sessions: async () => [], models: async () => [],
    modelDefault: async () => null, sessionSelection: async () => null, agents: async () => [],
    savedWorkspaces: async () => ({ initialized: true, workspaces: [] }),
    saveSavedWorkspaces: async () => {}, formsList: async () => [], inboxList: async () => [],
    listPermissions: async () => [], recoveryRecords: async () => [], closeSession: async () => {},
    openSession: async (directory, request) => info(directory, request),
    openSessionById: async (id) => ({ session: info("/replay", 0, id), transcript: [], todos: [], usage: null }),
    ...overrides
  } as OpenShellApi;
}

describe("Store lifecycle acquisition authority", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    container.remove();
  });
  async function mount(overrides: Partial<OpenShellApi> = {}) {
    window.openshell = api(overrides);
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
  }

  it("shares the monotonic request sequence between acquisition and transcript hydration", async () => {
    const calls: [string, number][] = [];
    await mount({
      openSession: async (directory, request) => { calls.push(["open", request]); return info(directory, request); },
      selectFolder: async (request) => { calls.push(["picker", request]); return info("/picked", request); },
      openSessionById: async (id, request) => {
        calls.push(["hydrate", request]);
        return { session: info("/replay", 0, id), transcript: [], todos: [], usage: null };
      }
    });
    await act(async () => store.addModelPanel("/one"));
    await act(async () => store.selectFolder());
    expect(calls).toEqual([["open", 1], ["hydrate", 2], ["picker", 3], ["hydrate", 4]]);
    expect(store.session?.directory).toBe("/picked");
  });

  it.each(["open", "add", "pick-add", "pick-replace", "swap"] as const)(
    "preserves ordered content and catalog launches for %s",
    async (operation) => {
      const trace: string[] = [];
      await mount({
        openSessionById: async (id) => {
          trace.push("hydrate");
          return { session: info("/replay", 0, id), transcript: [], todos: [], usage: null };
        },
        selectFolder: async (request) => info("/picked", request),
        inboxList: async () => { trace.push("inbox"); return []; },
        formsList: async () => { trace.push("forms"); return []; },
        recoveryRecords: async () => { trace.push("recovery"); return []; },
        models: async () => { trace.push("models"); return []; },
        agents: async () => { trace.push("agents"); return []; },
        sessions: async () => { trace.push("history"); return []; }
      });
      if (operation === "swap") await act(async () => store.addModelPanel("/initial"));
      trace.length = 0;
      await act(async () => {
        if (operation === "open") await store.openSession("/next");
        if (operation === "add") await store.addModelPanel("/next");
        if (operation === "pick-add") await store.selectAddPanel();
        if (operation === "pick-replace") await store.selectFolder();
        if (operation === "swap") await store.changePanelDirectory(store.session!.workspace, "/next");
      });
      expect(trace).toEqual(["hydrate", "inbox", "forms", "recovery", "models", "agents", "history"]);
      expect(store.session?.directory).toBe(operation.startsWith("pick") ? "/picked" : "/next");
    }
  );

  it("a cancelled replacement picker still supersedes an outstanding additive acquisition", async () => {
    const pending = deferred<SessionInfo>();
    const stale = info("/late", 1);
    const closeSession = vi.fn(async () => {});
    await mount({ openSession: () => pending.promise, selectFolder: async () => null, closeSession });
    let opening!: Promise<void>;
    act(() => { opening = store.addModelPanel("/late"); });
    await act(async () => store.selectFolder());
    await act(async () => { pending.resolve(stale); await opening; });
    expect(store.panels).toEqual([]);
    expect(store.activeSessionID).toBeNull();
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(stale.workspace);
  });

  it("retains reopen suppression until both same-session acquisitions settle", async () => {
    type Replay = Awaited<ReturnType<OpenShellApi["openSessionById"]>>;
    const older = deferred<Replay>();
    const newer = deferred<Replay>();
    const openSessionById = vi.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const closeSession = vi.fn(async () => {});
    await mount({ openSessionById, closeSession });
    let first!: Promise<SessionInfo | null>;
    let second!: Promise<SessionInfo | null>;
    act(() => { first = store.reopenSession("target"); second = store.reopenSession("target"); });
    act(() => receive({ kind: "session", session: info("/event-before", 3, "target") }));
    expect(store.panels).toEqual([]);
    const latest = info("/latest", 2, "target");
    await act(async () => { newer.resolve({ session: latest, transcript: [], todos: [], usage: null }); await second; });
    act(() => receive({ kind: "session", session: info("/event-between", 4, "target") }));
    expect(store.panels[0].directory).toBe("/latest");
    const stale = info("/stale", 1, "target");
    await act(async () => { older.resolve({ session: stale, transcript: [], todos: [], usage: null }); await first; });
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(stale.workspace);
    act(() => receive({ kind: "session", session: info("/event-after", 5, "target") }));
    expect(store.panels[0].directory).toBe("/event-after");
  });
});
