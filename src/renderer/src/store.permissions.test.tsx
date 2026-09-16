import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellApi } from "../../preload";
import type { BackendMessage, SessionInfo } from "@shared/types";
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

function api(listPermissions: OpenShellApi["listPermissions"]): OpenShellApi {
  return {
    platform: "darwin",
    onMessage: (handler: (message: BackendMessage) => void) => {
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
    openSession: async (directory: string, generation: number) => info(directory, generation),
    closeSession: async () => {},
    readFile: async () => "content",
    listDir: async () => [],
    listPermissions
  } as unknown as OpenShellApi;
}

function permissionEvent(sessionID: string, requestID: string): BackendMessage {
  return {
    kind: "event",
    type: "permission.asked",
    data: {
      id: `event-${requestID}`,
      type: "permission.asked",
      created: Date.now(),
      data: {
        id: requestID,
        sessionID,
        action: "bash",
        resources: ["rm -rf build"]
      }
    }
  };
}

describe("renderer permission prompts", () => {
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

  it("keeps an event-backed approval visible when the list is temporarily empty", async () => {
    window.openshell = api(async () => []);
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));

    await act(async () => {
      messageHandler!(permissionEvent(store.activeSessionID!, "request-1"));
      await Promise.resolve();
    });

    expect(store.transcript).toContainEqual(expect.objectContaining({
      kind: "permission",
      requestID: "request-1",
      pending: true
    }));
  });

  it("does not discard existing approvals when permission listing fails", async () => {
    const listPermissions = vi.fn<OpenShellApi["listPermissions"]>(async () => []);
    window.openshell = api(listPermissions);
    await act(async () => root.render(<StoreProvider><Probe /></StoreProvider>));
    await act(async () => store.openSession("/one"));
    await act(async () => {
      messageHandler!(permissionEvent(store.activeSessionID!, "request-1"));
    });

    listPermissions.mockRejectedValueOnce(new Error("permission endpoint unavailable"));
    await act(async () => {
      messageHandler!({ kind: "event", type: "server.connected", data: {} });
      await Promise.resolve();
    });

    expect(store.transcript).toContainEqual(expect.objectContaining({
      kind: "permission",
      requestID: "request-1",
      pending: true
    }));
  });
});
