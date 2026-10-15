import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSidebar } from "./FileSidebar";

const store = {
  session: { id: "session", directory: "/workspace", workspace: { id: "11111111-1111-4111-8111-111111111111", generation: 1 } },
  selectFolder: vi.fn(),
  tree: {},
  toggleDir: vi.fn(),
  ensureRootOpen: vi.fn(),
  agentFiles: new Map([
    ["gone.txt", { baseline: { kind: "known", content: "old" }, content: null, deleted: true }],
    ["a.txt", { baseline: { kind: "known", content: "old" }, content: "new", deleted: false }]
  ]),
  openFile: vi.fn(),
  expanded: new Set<string>(),
  hiddenPaths: new Set<string>(),
  pendingCreate: null,
  commitName: vi.fn(),
  cancelPending: vi.fn(),
  startCreate: vi.fn(),
  startRename: vi.fn(),
  deleteEntry: vi.fn(),
  removeFromWorkspace: vi.fn(),
  restoreRemovedFromWorkspace: vi.fn(),
  dismissChange: vi.fn(),
  dismissChanges: vi.fn()
};

const ctxMenuApi = {
  ctxMenu: null as { x: number; y: number; target: { path: string; type: "file" | "directory" } | null } | null,
  openCtxMenu: vi.fn(),
  closeCtxMenu: vi.fn()
};

vi.mock("../store", () => ({
  useStore: () => store,
  useCtxMenu: () => ctxMenuApi
}));

function render(): void {
  act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
}

function changesHeader(): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>(".section-toggle")].find(
    (button) => button.getAttribute("aria-label") === "Changes"
  )!;
}

function expandChanges(): void {
  act(() => {
    changesHeader().click();
  });
}

function rightClick(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 120 }));
  });
}

let container: HTMLDivElement;
let root: Root;

describe("FileSidebar changes menu", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    ctxMenuApi.ctxMenu = null;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("clears a single change from the row menu", () => {
    render();
    expandChanges();
    const row = container.querySelector(".changes-list .tree-row")!;
    expect(row.textContent).toContain("gone.txt");
    rightClick(row);

    const item = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx-item")].find(
      (button) => button.textContent === "Clear"
    )!;
    expect(item).toBeTruthy();
    act(() => {
      item.click();
    });

    expect(store.dismissChange).toHaveBeenCalledWith("gone.txt");
    expect(document.body.querySelector('[data-testid="changes-menu"]')).toBeNull();
  });

  it("clears every change from the header menu", () => {
    render();
    rightClick(changesHeader());

    const item = [...document.body.querySelectorAll<HTMLButtonElement>(".ctx-item")].find(
      (button) => button.textContent === "Clear all changes"
    )!;
    expect(item).toBeTruthy();
    act(() => {
      item.click();
    });

    expect(store.dismissChanges).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="changes-menu"]')).toBeNull();
  });

  it("renders the changes menu outside the sidebar", () => {
    render();
    rightClick(changesHeader());

    const menu = document.body.querySelector('[data-testid="changes-menu"]')!;
    expect(menu).toBeTruthy();
    expect(container.contains(menu)).toBe(false);
  });
});
