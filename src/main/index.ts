import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import path from "node:path";
import fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { OpenShellBackend } from "./opencode";
import { TerminalManager } from "./terminal";
import { MobileServer } from "./mobile-server";
import { defaultViteDeps, findHtmlEntry, resolveViteCommand, VitePreviewManager } from "./vite-server";
import { collectLaunchPaths, PendingOpenPaths } from "./open-paths";
import {
  applicationUrl,
  isAllowedMainFrameNavigation,
  isTrustedIpcSender,
  trustedApplicationLocation,
  type TrustedApplicationLocation
} from "./security";
import { safeExternalUrl } from "@shared/url-policy";
import { formatFailure, normalizeFailure } from "@shared/errors";
import { validateWithW3c } from "./w3c-validation";
import {
  DEFAULT_SESSION_SIZE,
  isWindowView,
  parseSessionBounds,
  serializeSessionBounds,
  type WindowSize,
  type WindowView
} from "./window-sizing";
import { resolveAppSource } from "./source-resolver";
import { InspectPickerState } from "./inspect-picker";
import type {
  FileWriteIdentity,
  PermissionReply,
  FormAnswers,
  PromptDelivery,
  PromptFile,
  WorkspaceIdentity
} from "@shared/types";
import {
  absoluteFilePath,
  absoluteFilePaths,
  confinedPath,
  fileContent,
  relativePath,
  terminalDimensions,
  terminalId,
  terminalInput,
  workspaceId
} from "./workspace-security";
import {
  activationGeneration,
  commandPayload,
  directoryPath,
  fileWriteIdentity,
  movePayload,
  optionalSelectionId,
  optionalRuntimeId,
  permissionPayload,
  providerCredentialPayload,
  promptPayload,
  queryText,
  selectionId,
  sessionId,
  workspacePath
} from "./ipc-schema";
import { applyExecPath } from "./exec-path";

// Must run before the first runtime probe or PTY spawn: GUI-launched builds do
// not inherit the user's shell PATH (see exec-path.ts).
applyExecPath();

const backend = new OpenShellBackend();
const terminals = new TerminalManager();
const mobileServer = new MobileServer();
const viteCommand = resolveViteCommand(app.getAppPath(), __dirname);
const viteServers = new VitePreviewManager(defaultViteDeps(viteCommand.command, viteCommand.prefix));
let win: BrowserWindow | null = null;
let trustedLocation: TrustedApplicationLocation | null = null;
const pendingOpenPaths = new PendingOpenPaths();

function flushOpenPaths(): void {
  if (pendingOpenPaths.size === 0) return;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoading()) return;
  const paths = pendingOpenPaths.take();
  if (paths.length === 0) return;
  win.webContents.send("shell:message", { kind: "ui-command", command: "open-paths", data: paths });
}

const appIconPath = (() => {
  const fromApp = path.join(app.getAppPath(), "resources", "icon.png");
  const fromOut = path.join(__dirname, "../../resources/icon.png");
  return existsSync(fromApp) ? fromApp : fromOut;
})();
const inspectPicker = new InspectPickerState();
let overlayEnabled = false;
let devToolsKeyPolling = false;

const DEVTOOLS_WATCHER = `
(() => {
  if (window.__openshellWatchInstalled) return;
  window.__openshellWatchInstalled = true;
  window.__openshellKey = null;
  window.__openshellOpenSource = null;
  window.addEventListener("keydown", (event) => {
    if (event.key === "F12" || event.key === "Escape") {
      window.__openshellKey = event.key;
    }
  }, true);
  const STRICT = /^(.*\\.(?:css|scss|sass|less|styl|stylus|pcss)):(\\d+)\\s*$/i;
  const LOOSE = /([^\\s]*\\.(?:css|scss|sass|less|styl|stylus|pcss)):(\\d+)/i;
  function attr(el, name) {
    return el && el.getAttribute ? el.getAttribute(name) : null;
  }
  function candidate(el) {
    if (!el || el.nodeType !== 1) return null;
    const sources = [attr(el, "title"), attr(el, "href"), attr(el, "data-url"), attr(el, "data-source-url")];
    for (const value of sources) {
      if (!value) continue;
      const clean = value.replace(/[?#].*$/, "");
      let m = STRICT.exec(clean.trim());
      if (m) return { file: m[1], line: parseInt(m[2], 10), title: value };
      m = LOOSE.exec(clean);
      if (m) return { file: m[1], line: parseInt(m[2], 10), title: value };
    }
    return null;
  }
  window.addEventListener("click", (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    let found = null;
    for (const el of path) {
      const c = candidate(el);
      if (c) { found = c; break; }
    }
    if (!found) return;
    event.preventDefault();
    event.stopPropagation();
    window.__openshellOpenSource = JSON.stringify({ file: found.file, line: found.line, title: found.title });
  }, true);
})();
`;

const INSPECT_HIGHLIGHT = {
  showInfo: true,
  showStyles: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 }
} as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ensureDevToolsOpen(wc: WebContents): Promise<void> {
  if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: "bottom" });
  for (let i = 0; i < 50 && !wc.devToolsWebContents; i++) await sleep(100);
  const dtc = wc.devToolsWebContents;
  if (dtc && dtc.isLoading()) {
    await new Promise<void>((resolve) => dtc.once("dom-ready", () => resolve()));
  }
}

async function startInspectPicker(wc: WebContents): Promise<void> {
  const token = inspectPicker.begin();
  await ensureDevToolsOpen(wc);
  if (!inspectPicker.isCurrent(token)) return;
  wc.focus();
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("DOM.enable");
    if (!inspectPicker.isCurrent(token)) return;
    await wc.debugger.sendCommand("Overlay.enable");
    if (!inspectPicker.isCurrent(token)) return;
    overlayEnabled = true;
    await wc.debugger.sendCommand("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: INSPECT_HIGHLIGHT
    });
    if (!inspectPicker.isCurrent(token)) await disableInspectMode(wc);
  } catch (err) {
    console.error("inspect picker failed:", err);
    if (inspectPicker.isCurrent(token)) inspectPicker.cancel();
  }
}

async function selectPickedNode(wc: WebContents, backendNodeId: number): Promise<void> {
  try {
    const { model } = await wc.debugger.sendCommand("DOM.getBoxModel", { backendNodeId });
    const q = model.content;
    const x = Math.round((Math.min(q[0], q[2], q[4], q[6]) + Math.max(q[0], q[2], q[4], q[6])) / 2);
    const y = Math.round((Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2);
    wc.inspectElement(x, y);
  } catch (err) {
    console.error("selectPickedNode:", err);
  }
}

async function disableInspectMode(wc: WebContents): Promise<void> {
  if (!overlayEnabled || !wc.debugger.isAttached()) return;
  await wc.debugger.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: INSPECT_HIGHLIGHT });
}

function stopInspectPicker(wc: WebContents): void {
  inspectPicker.cancel();
  void disableInspectMode(wc).catch((err) => console.error("stopInspectPicker:", err));
}

const LANDING_WIDTH = 760;
const LANDING_HEIGHT = 522;

function windowBoundsPath(): string {
  return path.join(app.getPath("userData"), "window-bounds.json");
}

function loadSessionBounds(): WindowSize | null {
  return parseSessionBounds(readFileSyncSafe(windowBoundsPath()) || null);
}

let windowView: WindowView = "landing";

let saveBoundsTimer: NodeJS.Timeout | null = null;

function scheduleBoundsSave(win: BrowserWindow): void {
  if (windowView !== "session") return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    try {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
      const [width, height] = win.getSize();
      writeFileSyncSafe(windowBoundsPath(), serializeSessionBounds({ width, height }));
    } catch {
      // persistence is best-effort
    }
  }, 400);
}

function applyWindowView(nextView: WindowView): void {
  windowView = nextView;
  if (!win || win.isDestroyed()) return;
  const size =
    nextView === "landing"
      ? { width: LANDING_WIDTH, height: LANDING_HEIGHT }
      : loadSessionBounds() ?? DEFAULT_SESSION_SIZE;
  if (!win.isMaximized() && !win.isFullScreen()) {
    win.setSize(size.width, size.height);
    // setSize preserves the top-left corner, so a landing → session grow
    // would otherwise extend down-right and look like a bottom-right
    // teleport. Re-center so the saved session size appears centered.
    win.center();
  }
}

function readFileSyncSafe(file: string): string {
  try {
    return require("node:fs").readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeFileSyncSafe(file: string, content: string): void {
  require("node:fs").writeFileSync(file, content);
}

function createWindow(show = true): BrowserWindow {
  const packagedUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;
  const rendererUrl = applicationUrl(app.isPackaged, process.env["ELECTRON_RENDERER_URL"], packagedUrl);
  const location = trustedApplicationLocation(rendererUrl);
  const newWin = new BrowserWindow({
    width: LANDING_WIDTH,
    height: LANDING_HEIGHT,
    minWidth: 200,
    minHeight: 200,
    title: "Orbit",
    icon: appIconPath,
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: process.platform === "darwin" ? "under-window" : undefined,
    visualEffectState: process.platform === "darwin" ? "active" : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    movable: true,
    resizable: true,
    fullscreenable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: app.isPackaged ? ["--openshell-packaged"] : []
    }
  });
  win = newWin;
  trustedLocation = location;
  inspectPicker.cancel();
  // Boot centered at the landing size so the first paint never anchors
  // to a cascaded corner before the session view applies its saved size.
  newWin.center();
  const wc = newWin.webContents;

  wc.on("console-message", (event) => {
    console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  newWin.on("unresponsive", () => console.warn("[orbit] renderer is unresponsive"));
  let lastRendererReload = 0;
  wc.on("render-process-gone", (_event, details) => {
    console.error("[orbit] renderer process gone:", details.reason, details.exitCode);
    if (newWin.isDestroyed() || Date.now() - lastRendererReload < 10_000) return;
    lastRendererReload = Date.now();
    wc.reload();
  });

  newWin.on("closed", () => {
    if (win === newWin) {
      win = null;
      trustedLocation = null;
    }
  });

  newWin.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (!isAllowedMainFrameNavigation(url, true, location)) event.preventDefault();
  });
  wc.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (!isAllowedMainFrameNavigation(url, isMainFrame, location)) event.preventDefault();
  });

  wc.debugger.on("message", (_e, method, params) => {
    if (method === "Overlay.inspectNodeRequested") {
      const backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
      if (typeof backendNodeId === "number" && inspectPicker.claim()) {
        void disableInspectMode(wc)
          .then(() => selectPickedNode(wc, backendNodeId))
          .catch((err) => console.error("selectPickedNode:", err));
      }
    } else if (method === "Overlay.inspectModeCanceled") {
      inspectPicker.cancel();
    }
  });
  wc.debugger.on("detach", () => {
    inspectPicker.cancel();
    overlayEnabled = false;
  });
  wc.on("devtools-closed", () => {
    devToolsKeyPolling = false;
    stopInspectPicker(wc);
  });

  const installDevToolsWatcher = (attempt = 0): void => {
    const dtc = wc.devToolsWebContents;
    if (!dtc || dtc.isDestroyed()) return;
    const run = (): void => {
      void dtc.executeJavaScript(DEVTOOLS_WATCHER).catch(() => {
        if (attempt < 5) setTimeout(() => installDevToolsWatcher(attempt + 1), 250);
      });
    };
    if (dtc.isLoading()) dtc.once("dom-ready", run);
    else run();
  };

  const pollDevTools = async (): Promise<void> => {
    while (devToolsKeyPolling) {
      await sleep(120);
      const dtc = wc.devToolsWebContents;
      if (!wc.isDevToolsOpened() || wc.isDestroyed() || !dtc || dtc.isDestroyed()) break;
      void dtc.executeJavaScript(DEVTOOLS_WATCHER).catch(() => {});
      const payload = await dtc
        .executeJavaScript(`(() => {
          const k = window.__openshellKey;
          window.__openshellKey = null;
          const s = window.__openshellOpenSource;
          window.__openshellOpenSource = null;
          return JSON.stringify({ key: k, source: s });
        })()`)
        .catch(() => null);
      if (typeof payload !== "string") continue;
      let parsed: { key?: string | null; source?: string | null };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.key === "F12") {
        wc.closeDevTools();
      } else if (parsed.key === "Escape" && inspectPicker.active) {
        stopInspectPicker(wc);
      }
      if (typeof parsed.source === "string") {
        try {
          const src = JSON.parse(parsed.source) as { file?: string; line?: number; title?: string };
          if (typeof src.file === "string" && typeof src.line === "number") {
            const resolved = await resolveAppSource(app.getAppPath(), src.file, src.title ?? "");
            if (resolved) {
              wc.send("shell:message", {
                kind: "ui-command",
                command: "open-source",
                path: resolved,
                line: src.line
              });
            } else {
              console.warn("open-source: no local file for", src.file, src.title ?? "");
            }
          }
        } catch (err) {
          console.error("open-source:", err);
        }
      }
    }
    devToolsKeyPolling = false;
  };

  wc.on("devtools-opened", () => {
    installDevToolsWatcher();
    if (!devToolsKeyPolling) {
      devToolsKeyPolling = true;
      void pollDevTools();
    }
  });

  newWin.webContents.on("before-input-event", (event, input) => {
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (input.type === "keyDown" && mod && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
      event.preventDefault();
      win?.webContents.send("shell:message", { kind: "ui-command", command: "toggle-word-wrap" });
      return;
    }
    if (input.type === "keyDown" && !mod && !input.alt && !input.shift && input.key === "F12") {
      event.preventDefault();
      if (newWin.webContents.isDevToolsOpened()) {
        newWin.webContents.closeDevTools();
      } else {
        newWin.webContents.openDevTools({ mode: "bottom" });
      }
      return;
    }
    if (input.type === "keyDown" && !mod && !input.alt && !input.shift && input.key === "Escape" && inspectPicker.active) {
      event.preventDefault();
      stopInspectPicker(wc);
      return;
    }
    if (input.type === "keyDown" && !input.isAutoRepeat && mod && input.shift && !input.alt && input.key.toLowerCase() === "c") {
      event.preventDefault();
      if (inspectPicker.active) {
        stopInspectPicker(newWin.webContents);
      } else {
        void startInspectPicker(newWin.webContents);
      }
    }
  });

  if (show) {
    let revealed = false;
    const reveal = (): void => {
      if (revealed || newWin.isDestroyed()) return;
      revealed = true;
      newWin.show();
    };
    newWin.once("ready-to-show", reveal);
    setTimeout(reveal, 5000);
  }
  newWin.on("resize", () => scheduleBoundsSave(newWin));
  newWin.webContents.on("did-finish-load", () => {
    setTimeout(flushOpenPaths, 500);
  });
  void newWin.loadURL(rendererUrl);
  return newWin;
}

async function runTrustBoundarySmoke(): Promise<void> {
  const trustedWindow = createWindow(false);
  await new Promise<void>((resolve, reject) => {
    trustedWindow.webContents.once("did-finish-load", () => resolve());
    trustedWindow.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`${code}: ${description}`)));
  });
  const trustedUrl = trustedWindow.webContents.getURL();
  const trustedIpc = await trustedWindow.webContents.executeJavaScript("window.openshell.state().then(() => true)");
  await trustedWindow.webContents.executeJavaScript("location.href = 'data:text/html,untrusted'");
  await sleep(100);
  const navigationDenied = trustedWindow.webContents.getURL() === trustedUrl;
  const windowsBeforePopup = BrowserWindow.getAllWindows().length;
  await trustedWindow.webContents.executeJavaScript("window.open('custom-protocol://unsafe')");
  await sleep(100);
  const popupDenied = BrowserWindow.getAllWindows().length === windowsBeforePopup;

  const untrustedWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await untrustedWindow.loadURL("data:text/html,<title>untrusted</title>");
  const untrustedIpcRejected = await untrustedWindow.webContents
    .executeJavaScript("window.openshell.state().then(() => false, () => true)");
  untrustedWindow.destroy();
  trustedWindow.destroy();
  const result = { trustedIpc, navigationDenied, popupDenied, untrustedIpcRejected };
  console.log(`[openshell-trust-smoke] ${JSON.stringify(result)}`);
  if (!Object.values(result).every(Boolean)) throw new Error(`trust smoke failed: ${JSON.stringify(result)}`);
}

async function installApplication(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "darwin") return { ok: false, message: "Install app is macOS-only" };
  if (app.isPackaged) return { ok: false, message: "Orbit is already running as a packaged app" };
  const script = path.join(app.getAppPath(), "scripts", "install-app.mjs");
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  for (const line of run.stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; message?: unknown };
      if (typeof parsed.ok === "boolean" && typeof parsed.message === "string") {
        return { ok: parsed.ok, message: parsed.message };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, message: run.stderr.trim() || `Install app failed (exit code ${run.code ?? "unknown"})` };
}

function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedLocation || !isTrustedIpcSender(event, win?.webContents ?? null, trustedLocation)) {
      throw new Error("Rejected IPC from an untrusted sender");
    }
    return listener(event, ...args as Args);
  });
}

function registerIpc(): void {
  handleTrusted("shell:select-folder", async (e, requestGeneration: number, requestedRuntimeID?: unknown) => {
    const generation = backend.beginActivation(activationGeneration(requestGeneration));
    const parent = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(parent ?? win!, {
      title: "Open a repository folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return backend.openSession(result.filePaths[0], generation, optionalRuntimeId(requestedRuntimeID));
  });

  handleTrusted("shell:select-directory", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(parent ?? win!, {
      title: "Save a workspace in Orbit",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return fsp.realpath(directoryPath(result.filePaths[0]));
  });

  handleTrusted("shell:select-file", async (e, requestGeneration: number, requestedRuntimeID?: unknown) => {
    const generation = backend.beginActivation(activationGeneration(requestGeneration));
    const parent = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(parent ?? win!, {
      title: "Open a file",
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return backend.openFileWorkspace(result.filePaths[0], generation, optionalRuntimeId(requestedRuntimeID));
  });

  handleTrusted("shell:open-file", async (_e, file: string, requestGeneration: number, requestedRuntimeID?: unknown) =>
    backend.openFileWorkspace(absoluteFilePath(file), backend.beginActivation(activationGeneration(requestGeneration)), optionalRuntimeId(requestedRuntimeID)));

  handleTrusted("shell:open-external", async (_e, workspace: WorkspaceIdentity, file: string) => {
    workspaceId(workspace);
    return backend.resolveExternalOpen(workspace, absoluteFilePath(file));
  });

  handleTrusted("shell:stat-external", async (_e, file: string) =>
    backend.statExternal(absoluteFilePath(file))
  );

  handleTrusted("shell:fs-write-standalone", async (
    _e,
    file: string,
    content: string,
    expectedContent: string,
    overwrite: boolean
  ) =>
    backend.writeStandaloneFile(absoluteFilePath(file), fileContent(content), fileContent(expectedContent), overwrite)
  );

  handleTrusted("shell:fs-import", async (
    _e,
    workspace: WorkspaceIdentity,
    destDir: string,
    sources: string[]
  ) => {
    workspaceId(workspace);
    return backend.importExternal(workspace, workspacePath(workspace, destDir, true).rel, absoluteFilePaths(sources));
  });

  handleTrusted("shell:open-session", async (_e, dir: string, requestGeneration: number, requestedRuntimeID?: unknown) =>
    backend.openSession(directoryPath(dir), backend.beginActivation(activationGeneration(requestGeneration)), optionalRuntimeId(requestedRuntimeID)));

  handleTrusted("shell:sessions", async () => backend.listSessions());

  handleTrusted("shell:active-sessions", async () => backend.activeSessions());

  handleTrusted("shell:close-session", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    viteServers.stop(workspace.id);
    return backend.closeSession(workspace);
  });

  handleTrusted("shell:open-session-id", async (_e, sessionID: string, requestGeneration: number, requestedRuntimeID?: unknown) =>
    backend.openSessionById(sessionId(sessionID), backend.beginActivation(activationGeneration(requestGeneration)), optionalRuntimeId(requestedRuntimeID))
  );

  handleTrusted("shell:delete-session", async (_e, sessionID: string) =>
    backend.deleteSession(sessionId(sessionID))
  );

  handleTrusted("shell:runtimes", async () => backend.runtimeManifests());

  handleTrusted("shell:sync-opencode", async () => backend.syncOpenCode());

  handleTrusted("shell:update-opencode", async () => backend.updateOpenCode());

  handleTrusted("shell:session-transcript", async (_e, sessionID: string) =>
    backend.sessionTranscript(sessionId(sessionID))
  );

  handleTrusted("shell:session-usage", async (_e, sessionID: string) =>
    backend.sessionUsage(sessionId(sessionID))
  );

  handleTrusted("shell:prompt", async (_e, workspace: WorkspaceIdentity, text: string, files: PromptFile[] = [], delivery?: PromptDelivery) => {
    try {
      const payload = promptPayload(workspace, text, files);
      return await backend.prompt(payload.workspace, payload.text, payload.files, delivery);
    } catch (error) {
      const failure = normalizeFailure(error, "ORBIT_PROMPT_FAILED", "Prompt failed");
      const reported = new Error(formatFailure(failure));
      reported.name = failure.code;
      Object.assign(reported, failure);
      throw reported;
    }
  });

  handleTrusted("shell:inbox-list", async (_e, workspace: WorkspaceIdentity) => backend.listInbox(workspace));
  handleTrusted("shell:inbox-cancel", async (_e, workspace: WorkspaceIdentity, inboxID: string) => backend.cancelInbox(workspace, inboxID));
  handleTrusted("shell:inbox-steer", async (_e, workspace: WorkspaceIdentity, inboxID: string) => backend.steerInbox(workspace, inboxID));
  handleTrusted("shell:forms-list", async (_e, workspace: WorkspaceIdentity) => backend.listForms(workspace));
  handleTrusted("shell:form-reply", async (_e, workspace: WorkspaceIdentity, formID: string, answers: FormAnswers, formSessionID?: string) => backend.replyForm(workspace, formID, answers, formSessionID));
  handleTrusted("shell:form-cancel", async (_e, workspace: WorkspaceIdentity, formID: string, formSessionID?: string) => backend.cancelForm(workspace, formID, formSessionID));

  handleTrusted("shell:commands", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listCommands(workspace);
  });

  handleTrusted("shell:run-command", async (_e, workspace: WorkspaceIdentity, name: string, args: string = "") => {
    await backend.workspaceDirectory(workspace);
    const command = commandPayload(name, args);
    return backend.runCommand(workspace, command.name, command.args);
  });

  handleTrusted("shell:find-files", async (_e, workspace: WorkspaceIdentity, query: string) => {
    workspaceId(workspace);
    return backend.searchFiles(workspace, queryText(query));
  });

  handleTrusted("shell:select-files", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(parent ?? win!, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"]
    });
    return result.canceled ? [] : result.filePaths;
  });

  handleTrusted("shell:select-images", async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(parent ?? win!, {
      title: "Upload images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tiff", "tif"] }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  handleTrusted("shell:read-image-preview", async (_e, file: string) => {
    try {
      const image = nativeImage.createFromPath(absoluteFilePath(file));
      if (image.isEmpty()) return null;
      const { width } = image.getSize();
      return (width > 128 ? image.resize({ width: 128 }) : image).toDataURL();
    } catch {
      return null;
    }
  });

  handleTrusted("shell:interrupt", async (_e, workspace: WorkspaceIdentity) => backend.interrupt(workspace));

  handleTrusted("shell:fs-list", async (_e, workspace: WorkspaceIdentity, rel: string) => {
    const target = workspacePath(workspace, rel, true);
    return backend.listDir(target.workspace, target.rel);
  });

  handleTrusted("shell:fs-reveal", async (_e, workspace: WorkspaceIdentity, rel: string) => {
    const target = workspacePath(workspace, rel, true);
    return backend.revealInFileManager(target.workspace, target.rel);
  });

  handleTrusted("shell:fs-read", async (_e, workspace: WorkspaceIdentity, rel: string) => {
    const target = workspacePath(workspace, rel);
    return backend.readFile(target.workspace, target.rel);
  });

  handleTrusted("shell:fs-write", async (
    _e,
    workspace: WorkspaceIdentity,
    rel: string,
    content: string,
    write: FileWriteIdentity
  ) => {
    const target = workspacePath(workspace, rel);
    return backend.writeFile(target.workspace, target.rel, fileContent(content), fileWriteIdentity(write, target.workspace));
  });

  handleTrusted("shell:fs-create-file", async (_e, workspace: WorkspaceIdentity, rel: string) =>
    backend.createFile(workspace, rel)
  );

  handleTrusted("shell:fs-create-dir", async (_e, workspace: WorkspaceIdentity, rel: string) =>
    backend.createDir(workspace, rel)
  );

  handleTrusted("shell:fs-delete", async (_e, workspace: WorkspaceIdentity, rel: string) =>
    backend.deletePath(workspace, rel)
  );

  handleTrusted("shell:fs-detach", async (_e, workspace: WorkspaceIdentity, rel: string) =>
    backend.detachPath(workspace, rel)
  );

  handleTrusted("shell:fs-rename", async (_e, workspace: WorkspaceIdentity, rel: string, newName: string) =>
    backend.renamePath(workspace, rel, newName)
  );

  handleTrusted("shell:fs-move", async (_e, workspace: WorkspaceIdentity, rel: string, newParent: string) => {
    const target = movePayload(workspace, rel, newParent);
    return backend.movePath(target.workspace, target.rel, target.newParent);
  });

  handleTrusted("shell:recovery-list", async (_e, workspace: WorkspaceIdentity) =>
    backend.listRecovery(workspace)
  );

  handleTrusted("shell:recovery-open", async (_e, workspace: WorkspaceIdentity, id: string) =>
    backend.openRecovery(workspace, selectionId(id, "recovery id"))
  );

  handleTrusted("shell:recovery-acknowledge", async (_e, workspace: WorkspaceIdentity, id: string) =>
    backend.acknowledgeRecovery(workspace, selectionId(id, "recovery id"))
  );

  handleTrusted("shell:projects", async () => backend.listProjects());

  handleTrusted("shell:models", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listModels(workspace);
  });

  handleTrusted("shell:model-default", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.modelDefault(workspace);
  });

  handleTrusted("shell:switch-model", async (_e, workspace: WorkspaceIdentity, id: string, providerID: string, variant?: string) =>
    backend.switchModel(
      workspace,
      selectionId(id, "model id"),
      selectionId(providerID, "provider id"),
      optionalSelectionId(variant, "model variant")
    )
  );

  handleTrusted("shell:permission-reply", async (
    _e,
    workspace: WorkspaceIdentity,
    requestID: string,
    reply: PermissionReply,
    sessionID: string
  ) => {
    const permission = permissionPayload(requestID, reply, sessionID);
    return backend.replyPermission(workspace, permission.requestID, permission.reply, permission.sessionID);
  });

  handleTrusted("shell:list-permissions", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listPermissions(workspace);
  });

  handleTrusted("shell:agents", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listAgents(workspace);
  });

  handleTrusted("shell:switch-agent", async (_e, workspace: WorkspaceIdentity, id: string) =>
    backend.switchAgent(workspace, selectionId(id, "agent id")));

  handleTrusted("shell:terminal-start", async (_e, workspace: WorkspaceIdentity, requestedId: string, rel = "") => {
    const target = workspacePath(workspace, rel, true);
    const root = await backend.workspaceDirectory(target.workspace);
    const directory = await confinedPath(root, target.rel, true);
    const stat = await fsp.stat(directory);
    if (!stat.isDirectory()) throw new Error("terminal path is not a directory");
    const id = terminalId(requestedId);
    await terminals.start(id, directory, target.workspace);
    try {
      await backend.workspaceDirectory(target.workspace);
    } catch (error) {
      terminals.stop(id, target.workspace);
      throw error;
    }
    return directory;
  });

  handleTrusted("shell:agent-tui-start", async (_e, workspace: WorkspaceIdentity, requestedId: string) => {
    const directory = await backend.ptyDirectory(workspace);
    const command = await backend.tuiCommand(workspace);
    const id = terminalId(requestedId);
    await terminals.start(id, directory, workspace, command);
    try {
      await backend.workspaceDirectory(workspace);
    } catch (error) {
      terminals.stop(id, workspace);
      throw error;
    }
  });

  handleTrusted("shell:terminal-input", async (_e, workspace: WorkspaceIdentity, id: string, data: string) => {
    await backend.workspaceDirectory(workspace);
    terminals.write(terminalId(id), terminalInput(data), workspace);
  });

  handleTrusted("shell:terminal-resize", async (_e, workspace: WorkspaceIdentity, id: string, cols: number, rows: number) => {
    await backend.workspaceDirectory(workspace);
    const dimensions = terminalDimensions(cols, rows);
    terminals.resize(terminalId(id), dimensions.cols, dimensions.rows, workspace);
  });

  handleTrusted("shell:terminal-stop", async (_e, workspace: WorkspaceIdentity, id: string) => {
    await backend.workspaceDirectory(workspace);
    terminals.stop(terminalId(id), workspace);
  });

  handleTrusted("shell:state", async () => backend.getState());

  handleTrusted("shell:session-selection", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.sessionSelection(workspace);
  });

  handleTrusted("shell:mcp-list", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listMcpServers(workspace);
  });
  handleTrusted("shell:plugins-list", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listPlugins(workspace);
  });
  handleTrusted("shell:skills-list", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listSkills(workspace);
  });

  handleTrusted("shell:provider-usage", async () => backend.providerUsage());

  handleTrusted("shell:provider-integrations", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.listProviderIntegrations(workspace);
  });

  handleTrusted("shell:provider-key-connect", async (
    _e,
    workspace: WorkspaceIdentity,
    integrationID: unknown,
    key: unknown,
    label: unknown,
    answers: unknown
  ) => {
    workspaceId(workspace);
    const credential = providerCredentialPayload(integrationID, key, label, answers);
    return backend.connectProviderKey(workspace, credential.integrationID, credential.key, credential.label, credential.answers);
  });

  handleTrusted("shell:provider-oauth-start", async (_e, workspace: WorkspaceIdentity, integrationID: string, methodID: string) => {
    workspaceId(workspace);
    return backend.startProviderOAuth(workspace, integrationID, methodID);
  });
  handleTrusted("shell:provider-oauth-poll", async (_e, workspace: WorkspaceIdentity, integrationID: string, attemptID: string) => {
    workspaceId(workspace);
    return backend.pollProviderOAuth(workspace, integrationID, attemptID);
  });
  handleTrusted("shell:provider-oauth-complete", async (_e, workspace: WorkspaceIdentity, integrationID: string, attemptID: string, code?: string) => {
    workspaceId(workspace);
    return backend.completeProviderOAuth(workspace, integrationID, attemptID, code);
  });
  handleTrusted("shell:provider-oauth-cancel", async (_e, workspace: WorkspaceIdentity, integrationID: string, attemptID: string) => {
    workspaceId(workspace);
    return backend.cancelProviderOAuth(workspace, integrationID, attemptID);
  });

  handleTrusted("shell:session-revert-stage", async (_e, workspace: WorkspaceIdentity, messageID: string, files: boolean) => {
    workspaceId(workspace);
    return backend.stageRevert(workspace, messageID, files);
  });
  handleTrusted("shell:session-revert-commit", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.commitRevert(workspace);
  });
  handleTrusted("shell:session-revert-clear", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    return backend.clearRevert(workspace);
  });

  handleTrusted("shell:provider-credential-remove", async (_e, workspace: WorkspaceIdentity, credentialID: unknown) => {
    workspaceId(workspace);
    return backend.removeProviderCredential(workspace, selectionId(credentialID, "provider credential id"));
  });

  handleTrusted("shell:health", async () => backend.connect().catch(() => false));

  handleTrusted("shell:window-view", (_e, view: unknown) => {
    if (!isWindowView(view)) return;
    applyWindowView(view);
  });

  // The native appearance tracks the active theme — only the Paper profile is
  // light — so window vibrancy and native chrome never follow a mismatched
  // system appearance.
  handleTrusted("shell:set-appearance", (_e, appearance: unknown) => {
    nativeTheme.themeSource = appearance === "light" ? "light" : "dark";
  });

  handleTrusted("shell:install-app", async () => installApplication());

  handleTrusted("shell:validate-w3c", async (_e, filePath: string, content: string) => {
    const path = directoryPath(filePath);
    const source = fileContent(content);
    return validateWithW3c(path, source);
  });

  handleTrusted("shell:vite-start", async (_e, workspace: WorkspaceIdentity, requestedEntry?: string) => {
    workspaceId(workspace);
    const directory = await backend.workspaceDirectory(workspace);
    let serveDirectory = directory;
    let entry = "";
    if (requestedEntry !== undefined) {
      const clean = relativePath(requestedEntry);
      const absolute = await confinedPath(directory, clean);
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat?.isFile() || !/\.html?$/i.test(absolute)) throw new Error("the Vite preview target must be an existing HTML file");
      serveDirectory = path.dirname(absolute);
      entry = path.basename(absolute).toLowerCase() === "index.html" ? "" : path.basename(absolute);
    } else {
      // A workspace root without index.html would otherwise 404 on `/` and
      // tear the server down. Fall back to the shallowest HTML page so a
      // static/docs folder still serves something useful.
      const rootIndex = await fsp.stat(path.join(directory, "index.html")).catch(() => null);
      if (!rootIndex?.isFile()) {
        const found = await findHtmlEntry(directory);
        if (found) {
          serveDirectory = path.dirname(found);
          entry = path.basename(found).toLowerCase() === "index.html" ? "" : path.basename(found);
        }
      }
    }
    const preview = await viteServers.start(workspace.id, serveDirectory, entry);
    void shell.openExternal(preview.url);
    return preview;
  });

  handleTrusted("shell:vite-stop", async (_e, workspace: WorkspaceIdentity) => {
    workspaceId(workspace);
    await backend.workspaceDirectory(workspace);
    viteServers.stop(workspace.id);
  });

  handleTrusted("shell:take-pending-paths", () => pendingOpenPaths.take());
}

if (!app.requestSingleInstanceLock()) {
  console.log("[orbit] another instance is already running — exiting; the running instance will open or focus its window");
  app.quit();
} else {
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
  });

  app.on("second-instance", (_event, argv) => {
    pendingOpenPaths.push(collectLaunchPaths(argv.slice(1), existsSync, process.execPath));
    if (!win || win.isDestroyed()) {
      createWindow();
    } else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    flushOpenPaths();
  });

  app.on("open-file", (event, path) => {
    event.preventDefault();
    pendingOpenPaths.push([path]);
    if (!win || win.isDestroyed()) {
      createWindow();
    } else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    flushOpenPaths();
  });

  app.whenReady().then(() => {
    app.setName("Orbit");
    // Window vibrancy and native chrome follow the native appearance, so pin
    // the dark default before any window exists; the renderer reports the
    // persisted theme through `shell:set-appearance` right after boot.
    nativeTheme.themeSource = "dark";
    if (process.platform === "darwin") {
      try {
        app.dock?.setIcon(appIconPath);
      } catch {
        // icon is cosmetic
      }
    }
    const trustSmoke = process.env["OPENSHELL_TRUST_SMOKE"] === "1";
    if (!trustSmoke) backend.start();
    const pendingFileUpdates = new Map<string, unknown>();
    let fileUpdateFlush: ReturnType<typeof setTimeout> | null = null;
    const flushFileUpdates = (): void => {
      fileUpdateFlush = null;
      const updates = [...pendingFileUpdates.values()];
      pendingFileUpdates.clear();
      for (const update of updates) {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("shell:message", update);
      }
    };
    const fwd = (msg: unknown): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "file-update") {
        const file = (msg as { file?: { workspace?: { id?: string }; path?: string } }).file;
        const key = `${file?.workspace?.id ?? ""}:${file?.path ?? ""}`;
        pendingFileUpdates.set(key, msg);
        if (!fileUpdateFlush) fileUpdateFlush = setTimeout(flushFileUpdates, 16);
        return;
      }
      win.webContents.send("shell:message", msg);
    };
    backend.onMessage(fwd);
    terminals.onMessage(fwd);
    registerIpc();
    if (trustSmoke) {
      void runTrustBoundarySmoke().then(
        () => app.quit(),
        (error) => {
          console.error("[openshell-trust-smoke]", error);
          process.exitCode = 1;
          app.quit();
        }
      );
      return;
    }
    createWindow();
    if (app.isPackaged) pendingOpenPaths.push(collectLaunchPaths(process.argv.slice(1), existsSync, process.execPath));
    void backend.connect()
      .then((connected) => {
        // Share the desktop's OpenCode daemon (and therefore its sessions) with
        // the mobile server when available.
        mobileServer.start(connected ? backend.mobileEndpoint() ?? undefined : undefined);
      })
      .catch(() => {
        mobileServer.start();
      });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  // macOS would normally keep the app alive with no window; Orbit must not
  // linger invisibly in the background (macOS then files it as a background
  // task), so closing the last window quits on every platform. The backend,
  // terminals, Vite servers and mobile server are stopped in `before-quit`.
  app.quit();
});

let quitting = false;

const QUIT_TIMEOUT_MS = 10_000;

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    // Bounded shutdown: terminals must reap their children before Node
    // teardown (a late pty exit callback aborts the process), but a wedged
    // child must never block quit forever.
    const shutdown = (async () => {
      await backend.stop();
      await terminals.stopAll();
      await viteServers.stopAll();
      await mobileServer.stop();
    })().catch(() => {});
    await Promise.race([
      shutdown,
      new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    ]);
    app.quit();
  })();
});
