import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { ThemeProvider } from "../theme";
import { SettingsPage } from "./SettingsPage";
import { SettingsSidebar } from "./SettingsSidebar";
import type { OrbitAppUpdateStatus } from "@shared/types";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,test-pairing-code") },
}));

type MockModel = { id: string; providerID: string; name: string };
type MockSession = { directory: string; workspace: { id: string; generation: number } };

const store = {
  session: null as MockSession | null,
  unsavedEditorFileCount: 0,
  unsavedEditorFiles: [] as Array<{ workspaceID: string; sessionID: string | null; workspace: { id: string; generation: number } | null; path: string; displayPath: string; standalone: boolean }>,
  focusSession: vi.fn(),
  openFile: vi.fn(async () => {}),
  openExternalPath: vi.fn(async () => null),
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
const mobileSetupStatus = vi.fn().mockResolvedValue({
  state: "ready",
  workspacePath: "/work/orbit-mobile",
  port: 3011,
});
const mobilePairingQr = vi.fn().mockResolvedValue({
  connectionUrl: "orbit://connect?v=2&p=one-time",
  expiresAt: "2099-01-01T00:00:00.000Z",
  serverLabel: "Orbit Desktop",
});
const checkAppUpdate = vi.fn();
const updateApp = vi.fn();

describe("SettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    store.unsavedEditorFileCount = 0;
    store.unsavedEditorFiles = [];
    store.focusSession.mockClear();
    store.openFile.mockClear();
    store.openExternalPath.mockClear();
    delete document.documentElement.dataset.theme;
    window.openshell = { setAppearance, mobileSetupStatus, mobilePairingQr, checkAppUpdate, updateApp } as unknown as typeof window.openshell;
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
      expect.stringContaining("Bloom"),
      expect.stringContaining("Kitty Glass"),
      expect.stringContaining("Original Dark")
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

  it.each(["kitty", "original"] as const)("restores the saved %s appearance without remapping it", (saved) => {
    window.localStorage.setItem("orbit.theme", saved);
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));

    expect(document.documentElement.dataset.theme).toBe(saved);
    expect(container.querySelector<HTMLButtonElement>(`.theme-card[aria-checked="true"]`)?.textContent)
      .toContain(saved === "kitty" ? "Kitty Glass" : "Original Dark");
    expect(setAppearance).toHaveBeenLastCalledWith("dark");
    expect(document.documentElement.style.getPropertyValue("--workspace-background"))
      .toBe(saved === "kitty" ? "transparent" : "#171412");
  });

  it("restores Kitty Glass transparency and clears it when choosing another profile", () => {
    act(() => root.render(<ThemeProvider><SettingsPage section="appearance" onClose={() => {}} /></ThemeProvider>));
    const cards = [...container.querySelectorAll<HTMLButtonElement>(".theme-card")];
    act(() => cards[10].click());

    expect(document.documentElement.dataset.theme).toBe("kitty");
    expect(window.localStorage.getItem("orbit.theme")).toBe("kitty");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("transparent");
    expect(document.documentElement.style.getPropertyValue("--panel-surface-image")).toContain("radial-gradient");

    act(() => cards[5].click());
    expect(document.documentElement.dataset.theme).toBe("prism");
    expect(document.documentElement.style.getPropertyValue("--panel-surface-image")).toBe("none");
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

  it("checks GitHub on About and starts the popup updater directly from Update Orbit", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    checkAppUpdate.mockResolvedValue({
      state: "available",
      branch: "main",
      currentCommit: "1111111111111111111111111111111111111111",
      latestCommit: "2222222222222222222222222222222222222222",
      commitsBehind: 2,
      commitsAhead: 3,
      hasLocalChanges: true
    });
    updateApp.mockResolvedValue({
      ok: true,
      updated: true,
      currentCommit: "1111111111111111111111111111111111111111",
      latestCommit: "2222222222222222222222222222222222222222",
      message: "Orbit updated to 2222222."
    });
    await act(async () => root.render(<ThemeProvider><SettingsPage section="about" onClose={() => {}} /></ThemeProvider>));
    expect(checkAppUpdate).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("2 commits ready · 1111111 → 2222222");
    expect(container.textContent).toContain("Preserves 3 local commits and worktree changes.");
    const updateButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-action-button")]
      .find((button) => button.textContent === "Update Orbit")!;
    expect(updateButton).toBeTruthy();
    expect([...container.querySelectorAll<HTMLButtonElement>(".settings-action-button")]
      .some((button) => button.textContent === "Check for updates")).toBe(true);

    await act(async () => {
      updateButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(updateApp).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Orbit updated to 2222222.");
    expect([...container.querySelectorAll<HTMLButtonElement>(".settings-action-button")]
      .some((button) => button.textContent === "Check for updates")).toBe(true);
  });

  it("starts an update while the initial status check is pending and ignores its stale result", async () => {
    let resolveCheck!: (status: OrbitAppUpdateStatus) => void;
    const pendingCheck = new Promise<OrbitAppUpdateStatus>((resolve) => { resolveCheck = resolve; });
    checkAppUpdate.mockReturnValueOnce(pendingCheck);
    updateApp.mockResolvedValue({
      ok: true,
      updated: true,
      currentCommit: "1111111111111111111111111111111111111111",
      latestCommit: "2222222222222222222222222222222222222222",
      message: "Orbit updated to 2222222."
    });

    await act(async () => root.render(<ThemeProvider><SettingsPage section="about" onClose={() => {}} /></ThemeProvider>));
    const updateButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-action-button")]
      .find((button) => button.textContent === "Update Orbit")!;
    expect(updateButton.disabled).toBe(false);

    await act(async () => {
      updateButton.click();
      await Promise.resolve();
    });
    expect(updateApp).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Orbit updated to 2222222.");

    await act(async () => resolveCheck({
      state: "available",
      branch: "main",
      currentCommit: "1111111111111111111111111111111111111111",
      latestCommit: "3333333333333333333333333333333333333333",
      commitsBehind: 4,
      commitsAhead: 0,
      hasLocalChanges: false
    }));
    expect(container.textContent).not.toContain("4 commits ready");
    expect(container.textContent).toContain("Orbit updated to 2222222.");
  });

  it("requires unsaved editor files to be saved before an update can relaunch Orbit", async () => {
    store.unsavedEditorFileCount = 2;
    store.unsavedEditorFiles = [
      { workspaceID: "workspace-1", sessionID: "session-1", workspace: { id: "workspace-1", generation: 1 }, path: "src/first.ts", displayPath: "/repo/src/first.ts", standalone: false },
      { workspaceID: "workspace-1", sessionID: "session-1", workspace: { id: "workspace-1", generation: 1 }, path: "src/second.ts", displayPath: "/repo/src/second.ts", standalone: false }
    ];
    checkAppUpdate.mockResolvedValue({
      state: "current",
      branch: "main",
      currentCommit: "1111111111111111111111111111111111111111",
      latestCommit: "1111111111111111111111111111111111111111",
      commitsBehind: 0,
      commitsAhead: 0,
      hasLocalChanges: false
    });
    await act(async () => root.render(<ThemeProvider><SettingsPage section="about" onClose={() => {}} /></ThemeProvider>));
    const updateButton = [...container.querySelectorAll<HTMLButtonElement>(".settings-action-button")]
      .find((button) => button.textContent === "Update Orbit")!;

    await act(async () => updateButton.click());

    expect(updateApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save 2 unsaved files before Orbit rebuilds and relaunches.");
    expect(container.textContent).toContain("/repo/src/first.ts");
    expect(container.textContent).toContain("/repo/src/second.ts");
  });

  it("opens the selected unsaved file in its workspace", async () => {
    store.unsavedEditorFileCount = 1;
    const workspace = { id: "workspace-1", generation: 1 };
    store.unsavedEditorFiles = [{
      workspaceID: workspace.id,
      sessionID: "session-1",
      workspace,
      path: "src/first.ts",
      displayPath: "/repo/src/first.ts",
      standalone: false
    }];
    const onClose = vi.fn();
    await act(async () => root.render(<ThemeProvider><SettingsPage section="about" onClose={onClose} /></ThemeProvider>));

    const open = container.querySelector<HTMLButtonElement>(".settings-unsaved-file")!;
    await act(async () => open.click());

    expect(store.focusSession).toHaveBeenCalledWith("session-1");
    expect(store.openFile).toHaveBeenCalledWith("src/first.ts", undefined, workspace);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("explains that Orbit must be reopened when the running main process has no updater handler", async () => {
    checkAppUpdate.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'shell:app-update-check': Error: No handler registered for shell:app-update-check"
    ));

    await act(async () => root.render(<ThemeProvider><SettingsPage section="about" onClose={() => {}} /></ThemeProvider>));

    expect(container.textContent).toContain("Quit Orbit completely and reopen it, then check again.");
    expect(container.textContent).not.toContain("No handler registered");
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

  it("shows the desktop-to-phone pairing walkthrough in Mobile Setup", async () => {
    await act(async () => {
      root.render(<ThemeProvider><SettingsPage section="mobile" onClose={() => {}} /></ThemeProvider>);
    });

    expect(container.textContent).toContain("Continue your workspace on your phone.");
    expect(container.textContent).toContain("Prepare this Mac");
    expect(container.textContent).toContain("Open Orbit Mobile");
    expect(container.textContent).toContain("Scan the code from this page");
    expect(container.querySelector<HTMLButtonElement>(".mobile-setup-generate")?.disabled).toBe(false);
    expect(container.textContent).toContain("Generate pairing QR");
    expect(mobileSetupStatus).toHaveBeenCalledTimes(1);
  });

  it("generates the pairing QR from the one-time URI returned by main", async () => {
    await act(async () => {
      root.render(<ThemeProvider><SettingsPage section="mobile" onClose={() => {}} /></ThemeProvider>);
    });
    const generate = container.querySelector<HTMLButtonElement>(".mobile-setup-generate");
    expect(generate?.disabled).toBe(false);

    await act(async () => {
      generate?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const qr = container.querySelector<HTMLImageElement>(".mobile-setup-qr-result img");
    expect(mobilePairingQr).toHaveBeenCalledTimes(1);
    expect(QRCode.toDataURL).toHaveBeenCalledWith("orbit://connect?v=2&p=one-time", {
      width: 480,
      margin: 2,
      errorCorrectionLevel: "L",
    });
    expect(qr?.src).toBe("data:image/png;base64,test-pairing-code");
    expect(qr?.alt).toContain("One-time Orbit Mobile pairing QR");
    expect(container.textContent).toContain("One use · expires in 10 minutes");
  });
});
