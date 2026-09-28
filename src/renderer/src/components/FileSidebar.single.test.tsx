import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "@shared/types";
import { FileSidebar } from "./FileSidebar";

type MockSession = { id: string; directory: string; workspace: { id: string; generation: number } };

const session: MockSession = {
  id: "session",
  directory: "/workspace",
  workspace: { id: "11111111-1111-4111-8111-111111111111", generation: 1 }
};

const initialTree: Record<string, TreeEntry[]> = {
  "": [
    { path: "alpha", type: "directory" as const },
    { path: "note.txt", type: "file" as const }
  ],
  alpha: []
};

const initialExpanded = new Set(["", "alpha"]);

const store: Record<string, unknown> = {
  session: session as MockSession | null,
  selectFolder: vi.fn(),
  tree: initialTree,
  toggleDir: vi.fn(),
  ensureRootOpen: vi.fn(),
  agentFiles: new Map(),
  openFile: vi.fn(),
  expanded: initialExpanded,
  openCtxMenu: vi.fn(),
  pendingCreate: null,
  commitName: vi.fn(),
  cancelPending: vi.fn(),
  ctxMenu: null,
  closeCtxMenu: vi.fn(),
  startCreate: vi.fn(),
  startRename: vi.fn(),
  deleteEntry: vi.fn(),
  moveEntry: vi.fn(),
  singleFile: null,
  openExternalPath: vi.fn(),
  importPaths: vi.fn(),
  dropIntoExplorer: vi.fn(),
  addModelPanel: vi.fn(),
  openSession: vi.fn(),
  openWorkspacePanel: vi.fn()
};

const ctxMenuApi = {
  ctxMenu: null,
  openCtxMenu: vi.fn(),
  closeCtxMenu: vi.fn()
};

vi.mock("../store", () => ({
  useStore: () => store,
  useCtxMenu: () => ctxMenuApi
}));

function dropEvent(files: string[]): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: event.target, configurable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: files.length > 0 ? ["Files"] : [],
      files: files.map((path) => ({ path }) as unknown as File),
      setData: vi.fn(),
      effectAllowed: "",
      dropEffect: ""
    }
  });
  return event;
}

function row(container: HTMLElement, name: string): HTMLElement | null {
  return ([...container.querySelectorAll<HTMLElement>(".tree-row")].find(
    (el) => el.querySelector(".tree-name")?.textContent === name
  ) ?? null);
}

describe("FileSidebar single-file mode and external drops", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.openshell = {
      externalKind: vi.fn(async (path: string) => ({ kind: /\.[^/]+$/.test(path) ? "file" as const : "directory" as const }))
    } as unknown as typeof window.openshell;
    store.singleFile = null;
    store.expanded = new Set(initialExpanded);
    store.openExternalPath = vi.fn();
    store.importPaths = vi.fn();
    store.dropIntoExplorer = vi.fn();
    store.openWorkspacePanel = vi.fn();
    store.ensureRootOpen = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.session = session;
    vi.unstubAllGlobals();
  });

  it("renders single-file mode with the file row and no explorer tree", () => {
    store.singleFile = "index.html";
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));

    expect(container.textContent).toContain("FILE");
    expect(container.textContent).toContain("index.html");
    expect(container.textContent).not.toContain("EXPLORER");
    expect(container.textContent).not.toContain("CHANGES");
    expect(container.textContent).not.toContain("alpha");
  });

  it("opens an external file dropped onto the empty explorer area", async () => {
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
    const tree = container.querySelector<HTMLElement>(".tree")!;
    await act(async () => {
      tree.dispatchEvent(dropEvent(["/outside/notes.txt"]));
      await Promise.resolve();
    });

    expect(store.dropIntoExplorer).toHaveBeenCalledWith(["/outside/notes.txt"]);
    expect(store.importPaths).not.toHaveBeenCalled();
  });

  it("imports an external file dropped onto a folder row", () => {
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
    const alpha = row(container, "alpha")!;
    act(() => {
      alpha.dispatchEvent(dropEvent(["/outside/patch.ts"]));
    });

    expect(store.importPaths).toHaveBeenCalledWith("alpha", ["/outside/patch.ts"]);
    expect(store.openExternalPath).not.toHaveBeenCalled();
  });

  it("opens an external folder as another workspace when the root is collapsed", async () => {
    store.expanded = new Set(["alpha"]);
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
    const tree = container.querySelector<HTMLElement>(".tree")!;
    await act(async () => {
      tree.dispatchEvent(dropEvent(["/outside/advanced-web-concepts"]));
      await Promise.resolve();
    });

    expect(store.openWorkspacePanel).toHaveBeenCalledWith("/outside/advanced-web-concepts");
    expect(store.dropIntoExplorer).not.toHaveBeenCalled();
  });

  it("opens an external folder dropped directly on the collapsed root", async () => {
    store.expanded = new Set(["alpha"]);
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
    const workspace = row(container, "workspace")!;
    await act(async () => {
      workspace.dispatchEvent(dropEvent(["/outside/advanced-web-concepts"]));
      await Promise.resolve();
    });

    expect(store.openWorkspacePanel).toHaveBeenCalledWith("/outside/advanced-web-concepts");
    expect(store.dropIntoExplorer).not.toHaveBeenCalled();
  });
});
