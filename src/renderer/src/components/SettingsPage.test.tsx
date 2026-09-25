import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme";
import { SettingsPage } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";

type MockModel = { id: string; providerID: string; name: string };
type MockSession = { directory: string; workspace: { id: string; generation: number } };

const store = {
  session: null as MockSession | null,
  runtimes: [],
  models: [] as MockModel[],
  currentModel: null as MockModel | null,
  switchModel: vi.fn(),
  providerUsage: [],
  refreshProviderUsage: vi.fn(),
  loadModels: vi.fn(),
  refreshRuntimes: vi.fn(async () => []),
  approvalMode: "ask",
  toggleApprovalMode: vi.fn(),
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

  it("defaults to Prism, persists color-profile selection, restores it, and tracks native appearance", () => {
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));

    const cards = [...container.querySelectorAll<HTMLButtonElement>(".theme-card")];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Quiet Habitat"),
      expect.stringContaining("Control Deck"),
      expect.stringContaining("Papertrail"),
      expect.stringContaining("Shell First"),
      expect.stringContaining("Swiss Grid"),
      expect.stringContaining("Prism"),
      expect.stringContaining("Workshop"),
      expect.stringContaining("Blueprint"),
      expect.stringContaining("Stillness"),
      expect.stringContaining("Bloom")
    ]);
    expect(document.documentElement.dataset.theme).toBe("prism");
    expect(window.localStorage.getItem("orbit.theme")).toBe("prism");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");

    act(() => cards[2].click());
    expect(document.documentElement.dataset.theme).toBe("papertrail");
    expect(cards[2].getAttribute("aria-checked")).toBe("true");
    expect(setAppearance).toHaveBeenLastCalledWith("light");

    act(() => root.unmount());
    container.remove();
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));
    expect(document.documentElement.dataset.theme).toBe("papertrail");
    expect(setAppearance).toHaveBeenLastCalledWith("light");

    const restored = [...container.querySelectorAll<HTMLButtonElement>(".theme-card")];
    act(() => restored[5].click());
    expect(document.documentElement.dataset.theme).toBe("prism");
    expect(window.localStorage.getItem("orbit.theme")).toBe("prism");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");

    act(() => restored[0].click());
    expect(document.documentElement.dataset.theme).toBe("quiet-habitat");
    expect(window.localStorage.getItem("orbit.theme")).toBe("quiet-habitat");
    expect(setAppearance).toHaveBeenLastCalledWith("light");
  });

  it("keeps editor wrapping enabled without a wrap control", () => {
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));
    expect(container.textContent).not.toContain("Word wrap");
    expect(container.querySelector('[role="switch"]')).toBeNull();
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

  it("keeps default model settings and removes runtime selection", async () => {
    const workspace = { id: "workspace-1", generation: 1 };
    store.session = { directory: "/repo", workspace };
    store.models = [{ id: "model-1", providerID: "provider-1", name: "Model One" }];
    store.currentModel = store.models[0];

    await act(async () => root.render(<ThemeProvider><SettingsPage section="model" onClose={() => {}} /></ThemeProvider>));

    expect(container.textContent).toContain("Default model");
    expect(container.textContent).not.toContain("Agent runtime");
    expect(store.loadModels).toHaveBeenCalledWith(workspace);
    expect(container.querySelector<HTMLSelectElement>(".settings-list-row select")?.value).toBe("provider-1:model-1");

    store.session = null;
    store.models = [];
    store.currentModel = null;
  });
});
