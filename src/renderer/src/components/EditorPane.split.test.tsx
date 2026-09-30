import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@shared/types";
import { ThemeProvider } from "../theme";
import { EditorPane } from "./EditorPane";

const firstTab: Tab = {
  path: "src/one.ts",
  name: "one.ts",
  content: "one",
  saved: "one",
  baseline: null,
  mode: "edit",
  dirty: false,
  stale: false,
  deleted: false,
  revision: 0,
  conflict: null,
  binary: false
};
const secondTab: Tab = { ...firstTab, path: "src/two.ts", name: "two.ts", content: "two", saved: "two" };
const thirdTab: Tab = { ...firstTab, path: "src/three.ts", name: "three.ts", content: "three", saved: "three" };
const fourthTab: Tab = { ...firstTab, path: "src/four.ts", name: "four.ts", content: "four", saved: "four" };

const store = {
  tabs: [firstTab, secondTab],
  activePath: firstTab.path,
  session: { directory: "/workspace", workspace: { id: "workspace-1", generation: 1 } },
  openPaths: vi.fn(),
  setActive: vi.fn(),
  closeTab: vi.fn(),
  setTabMode: vi.fn(),
  editContent: vi.fn(),
  saveTab: vi.fn(),
  reloadTab: vi.fn(),
  overwriteTab: vi.fn(),
  mergeTab: vi.fn()
};
store.setActive.mockImplementation((path: string) => { store.activePath = path; });

vi.mock("../store", () => ({ useStore: () => store }));
vi.mock("../emmet-keys", () => ({ wireEmmetKeys: vi.fn() }));
vi.mock("../editor-navigation", () => ({ wireEditorNavigationKeys: vi.fn() }));
vi.mock("../monaco", () => ({ languageForPath: () => "typescript" }));
vi.mock("../w3c-validation", () => ({ clearW3cMarkers: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({
  default: ({ path, defaultValue, onMount }: { path: string; defaultValue: string; onMount?: (editor: unknown) => void }) => {
    const model = {
      getValue: () => defaultValue,
      getOptions: () => ({ tabSize: 4, insertSpaces: true })
    };
    onMount?.({
      getPosition: () => ({ lineNumber: 8, column: 13 }),
      getModel: () => model,
      onDidChangeCursorPosition: () => ({ dispose: () => {} })
    });
    return <div data-testid="editor" data-path={path} />;
  },
  DiffEditor: () => <div data-testid="diff-editor" />
}));

describe("EditorPane split groups", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.tabs = [firstTab, secondTab, thirdTab];
    store.activePath = firstTab.path;
    store.setActive.mockClear();
    store.saveTab.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens two side-by-side editor groups and closes the secondary group", () => {
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Split editor right"]')!.click());

    const groups = [...container.querySelectorAll<HTMLElement>(".editor-group")];
    expect(groups).toHaveLength(2);
    expect(groups[1].classList).toContain("editor-group-focused");
    expect(groups[0].querySelector("[data-testid=editor]")?.getAttribute("data-path")).toBe(firstTab.path);
    expect(groups[1].querySelector("[data-testid=editor]")?.getAttribute("data-path")).toBe(secondTab.path);
    expect([...groups[0].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([
      firstTab.path,
      thirdTab.path
    ]);
    expect([...groups[1].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([
      secondTab.path
    ]);

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close secondary editor group"]')!.click());
    expect(container.querySelectorAll(".editor-group")).toHaveLength(1);
    expect(container.querySelector("[data-testid=editor]")?.getAttribute("data-path")).toBe(firstTab.path);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
  });

  it("offers an explicit save action for a dirty file", () => {
    store.tabs = [{ ...firstTab, content: "unfinished", dirty: true, revision: 1 }];
    store.activePath = firstTab.path;
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    const save = container.querySelector<HTMLButtonElement>(`[aria-label="Save ${firstTab.name}"]`)!;
    expect(save).toBeTruthy();
    act(() => save.click());
    expect(store.saveTab).toHaveBeenCalledWith(firstTab.path);
  });

  it("reports cursor details from the focused Monaco editor", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<ThemeProvider><EditorPane onStatusChange={onStatusChange} /></ThemeProvider>));
    expect(onStatusChange).toHaveBeenLastCalledWith({
      path: firstTab.path,
      lineNumber: 8,
      column: 13,
      tabSize: 4,
      insertSpaces: true
    });

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Split editor right"]')!.click());
    expect(onStatusChange).toHaveBeenLastCalledWith({
      path: secondTab.path,
      lineNumber: 8,
      column: 13,
      tabSize: 4,
      insertSpaces: true
    });
  });

  it("routes new files and save shortcuts to the group focused from its editor surface", () => {
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Split editor right"]')!.click());

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true })));
    expect(store.saveTab).toHaveBeenCalledTimes(1);
    expect(store.saveTab).toHaveBeenLastCalledWith(secondTab.path);

    const primary = container.querySelector<HTMLElement>('[aria-label="Primary editor"]')!;
    act(() => primary.querySelector<HTMLElement>("[data-testid=editor]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(primary.classList).toContain("editor-group-focused");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })));
    expect(store.saveTab).toHaveBeenCalledTimes(2);
    expect(store.saveTab).toHaveBeenLastCalledWith(firstTab.path);
    let paths = [...container.querySelectorAll<HTMLElement>("[data-testid=editor]")].map((editor) => editor.dataset.path);
    expect(paths).toEqual([firstTab.path, secondTab.path]);

    const secondary = container.querySelector<HTMLElement>('[aria-label="Secondary editor"]')!;
    act(() => secondary.querySelector<HTMLElement>("[data-testid=editor]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(secondary.classList).toContain("editor-group-focused");
    paths = [...container.querySelectorAll<HTMLElement>("[data-testid=editor]")].map((editor) => editor.dataset.path);
    expect(paths).toEqual([firstTab.path, secondTab.path]);

    store.tabs = [...store.tabs, fourthTab];
    store.activePath = fourthTab.path;
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    paths = [...container.querySelectorAll<HTMLElement>("[data-testid=editor]")].map((editor) => editor.dataset.path);
    expect(paths).toEqual([firstTab.path, fourthTab.path]);
    const groups = [...container.querySelectorAll<HTMLElement>(".editor-group")];
    expect([...groups[0].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([
      firstTab.path,
      thirdTab.path
    ]);
    expect([...groups[1].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([
      secondTab.path,
      fourthTab.path
    ]);
  });

  it("routes a newly opened file into an initially empty secondary group", () => {
    store.tabs = [firstTab];
    store.activePath = firstTab.path;
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Split editor right"]')!.click());
    expect(container.querySelector(".editor-group-secondary .editor-group-empty")).toBeTruthy();

    store.tabs = [firstTab, secondTab];
    store.activePath = secondTab.path;
    act(() => root.render(<ThemeProvider><EditorPane /></ThemeProvider>));

    const groups = [...container.querySelectorAll<HTMLElement>(".editor-group")];
    expect(groups[0].querySelector("[data-testid=editor]")?.getAttribute("data-path")).toBe(firstTab.path);
    expect(groups[1].querySelector("[data-testid=editor]")?.getAttribute("data-path")).toBe(secondTab.path);
    expect([...groups[0].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([firstTab.path]);
    expect([...groups[1].querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.title)).toEqual([secondTab.path]);
  });
});
