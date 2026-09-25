import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme";
import { SettingsPage } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";

const store = {
  session: null,
  models: [],
  currentModel: null,
  switchModel: vi.fn(),
  providerUsage: [],
  refreshProviderUsage: vi.fn(),
  loadModels: vi.fn(),
  approvalMode: "ask",
  toggleApprovalMode: vi.fn(),
  wordWrap: false,
  toggleWordWrap: vi.fn(),
  followUpBehavior: "queue",
  setFollowUpBehavior: vi.fn()
};

vi.mock("../store", () => ({ useStore: () => store }));

const setAppearance = vi.fn().mockResolvedValue(undefined);

describe("SettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    window.openshell = { setAppearance } as unknown as typeof window.openshell;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults to the dark original profile, persists selection, restores it, and tracks the native appearance", () => {
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));

    const cards = [...container.querySelectorAll<HTMLButtonElement>(".theme-card")];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Kitty Glass"),
      expect.stringContaining("Paper Editorial"),
      expect.stringContaining("Original")
    ]);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem("orbit.theme")).toBe("original");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");

    act(() => cards[1].click());
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(cards[1].getAttribute("aria-checked")).toBe("true");
    expect(setAppearance).toHaveBeenLastCalledWith("light");

    act(() => root.unmount());
    container.remove();
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(setAppearance).toHaveBeenLastCalledWith("light");

    const restored = [...container.querySelectorAll<HTMLButtonElement>(".theme-card")];
    act(() => restored[2].click());
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem("orbit.theme")).toBe("original");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");

    act(() => restored[0].click());
    expect(document.documentElement.dataset.theme).toBe("kitty");
    expect(window.localStorage.getItem("orbit.theme")).toBe("kitty");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");
  });

  it("provides dedicated settings navigation with About as the final tab", () => {
    const onSectionChange = vi.fn();
    act(() => root.render(<SettingsSidebar section="appearance" onSectionChange={onSectionChange} />));

    const labels = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav-item")].map((button) => button.textContent);
    expect(labels).toEqual(["Appearance", "Plugins", "Providers", "Safety", "Voice", "Model", "Servers", "Mobile Setup", "About"]);
    expect(container.querySelector<HTMLButtonElement>(".settings-nav-item:last-child")?.textContent).toBe("About");

    act(() => container.querySelectorAll<HTMLButtonElement>(".settings-nav-item")[5].click());
    expect(onSectionChange).toHaveBeenCalledWith("model");
  });
});
