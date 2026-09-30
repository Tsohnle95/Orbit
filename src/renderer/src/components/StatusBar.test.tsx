import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@shared/types";
import { StatusBar } from "./StatusBar";
import { applyW3cMarkers } from "../w3c-validation";
import type { EditorStatus } from "./editor-status";

const htmlTab: Tab = {
  path: "index.html",
  name: "index.html",
  content: "<p>hi",
  saved: "<p>hi",
  baseline: null,
  deleted: false,
  dirty: false,
  stale: false,
  revision: 0,
  conflict: null,
  mode: "edit",
  binary: false
};
const cssTab: Tab = { ...htmlTab, path: "styles.css", name: "styles.css", content: "body { color: red; }" };
const tsTab: Tab = { ...htmlTab, path: "app.ts", name: "app.ts", content: "const x = 1;" };

const store: { tabs: Tab[]; activePath: string | null } = {
  tabs: [htmlTab],
  activePath: htmlTab.path
};

vi.mock("../store", () => ({ useStore: () => store }));
vi.mock("../w3c-validation", () => ({
  applyW3cMarkers: vi.fn(),
  clearW3cMarkers: vi.fn()
}));

describe("StatusBar validation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store.tabs = [htmlTab];
    store.activePath = htmlTab.path;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("only shows the validate button for HTML and CSS files", () => {
    store.tabs = [];
    store.activePath = null;
    act(() => root.render(<StatusBar />));
    expect(container.querySelector('[data-testid="validate-btn"]')).toBeNull();

    store.tabs = [tsTab];
    store.activePath = tsTab.path;
    act(() => root.render(<StatusBar />));
    expect(container.querySelector('[data-testid="validate-btn"]')).toBeNull();
  });

  it("runs the W3C validator for an open HTML file and shows the marker counts", async () => {
    const diagnostics = [
      { line: 1, column: 1, endLine: 1, endColumn: 2, message: "bad", severity: "error", source: "w3c-html" },
      { line: 2, column: 1, endLine: 2, endColumn: 2, message: "warn", severity: "warning", source: "w3c-html" },
      { line: 3, column: 1, endLine: 3, endColumn: 2, message: "also bad", severity: "error", source: "w3c-html" }
    ];
    window.openshell = { validateW3c: vi.fn(async () => diagnostics) } as unknown as typeof window.openshell;

    act(() => root.render(<StatusBar />));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="validate-btn"]')!;
    expect(button.disabled).toBe(false);
    expect(button.closest(".statusbar-left")).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(window.openshell.validateW3c).toHaveBeenCalledWith("index.html", "<p>hi");
    expect(applyW3cMarkers).toHaveBeenCalledWith("index.html", diagnostics);
    expect(container.querySelector('[data-testid="validate-result"]')?.textContent).toBe("2 errors, 1 warning");
  });

  it("reports a clean file and resets the result when the content changes", async () => {
    window.openshell = { validateW3c: vi.fn(async () => []) } as unknown as typeof window.openshell;

    act(() => root.render(<StatusBar />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="validate-btn"]')!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="validate-result"]')?.textContent).toBe("No problems");

    store.tabs = [{ ...htmlTab, content: "<p>changed" }];
    act(() => root.render(<StatusBar />));
    expect(container.querySelector('[data-testid="validate-result"]')).toBeNull();
  });

  it("shows a failure state when the validator rejects", async () => {
    window.openshell = { validateW3c: vi.fn(async () => { throw new Error("network down"); }) } as unknown as typeof window.openshell;

    act(() => root.render(<StatusBar />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="validate-btn"]')!.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="validate-result"]')?.textContent).toBe("Validation failed");
  });

  it("shows cursor, indentation, and encoding details for the active editor", () => {
    const status: EditorStatus = {
      path: htmlTab.path,
      lineNumber: 123,
      column: 61,
      tabSize: 4,
      insertSpaces: true
    };
    act(() => root.render(<StatusBar editorStatus={status} />));

    expect(container.querySelector('[data-testid="cursor-position"]')?.textContent).toBe("Ln 123, Col 61");
    expect(container.querySelector('[data-testid="indentation-status"]')?.textContent).toBe("Spaces: 4");
    expect(container.querySelector('[data-testid="encoding-status"]')?.textContent).toBe("UTF-8");
    expect(container.querySelector('[data-testid="cursor-position"]')?.closest(".statusbar-right")).not.toBeNull();
  });

  it("does not display cursor details from another file", () => {
    const status: EditorStatus = {
      path: "other.ts",
      lineNumber: 99,
      column: 40,
      tabSize: 8,
      insertSpaces: false
    };
    act(() => root.render(<StatusBar editorStatus={status} />));

    expect(container.querySelector('[data-testid="cursor-position"]')?.textContent).toBe("Ln 1, Col 1");
    expect(container.querySelector('[data-testid="indentation-status"]')?.textContent).toBe("Spaces: 2");
  });
});
