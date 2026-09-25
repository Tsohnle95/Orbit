import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFileState, SessionInfo, Tab } from "@shared/types";
import { FileSidebar } from "./FileSidebar";
import { EditorPane } from "./EditorPane";
import { ThemeProvider } from "../theme";

const unknownFile: AgentFileState = { baseline: { kind: "unknown" }, content: "after", deleted: false };
const tab: Tab = {
  path: "src/unknown.ts",
  name: "unknown.ts",
  content: "after",
  saved: "after",
  baseline: { kind: "unknown" },
  mode: "diff",
  dirty: false,
  stale: false,
  deleted: false,
  revision: 0,
  conflict: null,
  binary: false
};
const session: SessionInfo = {
  id: "session",
  directory: "/workspace",
  workspace: { id: "11111111-1111-4111-8111-111111111111", generation: 1 }
};
const store = {
  session,
  selectFolder: vi.fn(),
  tree: { "": [] },
  toggleDir: vi.fn(),
  ensureRootOpen: vi.fn(),
  agentFiles: new Map([[tab.path, unknownFile]]),
  openFile: vi.fn(),
  expanded: new Set<string>(),
  openCtxMenu: vi.fn(),
  pendingCreate: null,
  commitName: vi.fn(),
  cancelPending: vi.fn(),
  tabs: [tab],
  activePath: tab.path,
  setActive: vi.fn(),
  closeTab: vi.fn(),
  setTabMode: vi.fn(),
  editContent: vi.fn(),
  saveTab: vi.fn(),
  reloadTab: vi.fn(),
  overwriteTab: vi.fn(),
  mergeTab: vi.fn(),
};

const ctxMenuApi = { ctxMenu: null, openCtxMenu: vi.fn(), closeCtxMenu: vi.fn() };

vi.mock("../store", () => ({
  useStore: () => store,
  useCtxMenu: () => ctxMenuApi
}));
vi.mock("../emmet-keys", () => ({ wireEmmetKeys: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="editor" />,
  DiffEditor: ({ options }: { options?: { renderOverviewRuler?: boolean; scrollbar?: { verticalScrollbarSize?: number } } }) => (
    <div
      data-testid="diff-editor"
      data-overview-ruler={String(options?.renderOverviewRuler)}
      data-scrollbar-width={String(options?.scrollbar?.verticalScrollbarSize)}
    />
  )
}));
vi.mock("../monaco", () => ({
  languageForPath: () => "typescript",
  monaco: { editor: { setModelMarkers: vi.fn() } }
}));
vi.mock("../diagnostics", () => ({
  createDiagnosticsScheduler: () => ({ schedule: vi.fn(), cancel: vi.fn() }),
  isHtmlFile: () => false,
  validateHtmlContent: () => []
}));

describe("unknown baseline presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.tabs = [tab];
    store.activePath = tab.path;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("labels a Changes row as observed when pre-change content is unavailable", () => {
    act(() => root.render(<FileSidebar collapsed={false} onCollapse={() => {}} onDrag={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>(".section-toggle")!.click());

    expect(container.querySelector(".tree-meta")?.textContent).toBe("observed");
    expect(container.querySelector(".changes-list .tree-row")?.getAttribute("title")).toContain("pre-change content unavailable");
  });

  it("shows Diff unavailable and does not mount a diff editor", () => {
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    const unavailable = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Diff unavailable"));
    expect(unavailable).toBeTruthy();
    expect(unavailable?.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector("[data-testid=editor]")).toBeTruthy();
    expect(container.querySelector("[data-testid=diff-editor]")).toBeNull();
  });

  it("disables the diff overview ruler for known baselines", () => {
    const knownTab: Tab = {
      ...tab,
      baseline: { kind: "known", content: "before" }
    };
    store.tabs = [knownTab];
    store.activePath = knownTab.path;

    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    expect(container.querySelector("[data-testid=diff-editor]")?.getAttribute("data-overview-ruler")).toBe("false");
    expect(container.querySelector("[data-testid=diff-editor]")?.getAttribute("data-scrollbar-width")).toBe("3");
  });
});
