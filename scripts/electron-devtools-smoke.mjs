import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import electron from "electron";

if (process.platform !== "darwin") {
  console.log("[electron-devtools-smoke] skipped: native DevTools coverage runs on macOS");
  process.exit(0);
}
const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "orbit-devtools-smoke-"));
const entry = path.join(temporary, "main.cjs");
const source = String.raw`
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DevToolsController } = require(CONTROLLER);
const { resolveAppSource } = require(RESOLVER);
const root = ROOT;
app.setPath("userData", PROFILE);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, label) => {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out: " + label);
    await delay(50);
  }
};
const watchdog = setTimeout(() => app.exit(2), 40000);
(async () => {
  await app.whenReady();
  const session = { id: "devtools-smoke", directory: path.join(root, "design"), workspace: { id: "11111111-1111-4111-8111-111111111111", generation: 1 } };
  const sourcePath = path.join(root, "src/renderer/src/styles/_sidebar.scss");
  const content = fs.readFileSync(sourcePath, "utf8");
  const line = content.split("\n").findIndex(value => value === ".sidebar-brand {") + 1;
  assert.ok(line > 0);
  let externalRead = null;
  let healthChecked = false;
  // Keep this integration offline: use the real preload/store/editor with a
  // fixture backend. Only the app-owned source resolver reads stylesheet paths.
  const channels = new Set([...fs.readFileSync(path.join(root, "src/preload/index.ts"), "utf8").matchAll(/ipcRenderer.invoke\("([^"]+)"/g)].map(match => match[1]));
  for (const channel of channels) ipcMain.handle(channel, async (_event, ...args) => {
    if (channel === "shell:health") { healthChecked = true; return true; }
    if (channel === "shell:state") return session;
    if (channel === "shell:active-sessions") return [session];
    if (channel === "shell:open-session-id") return { session, transcript: [], todos: [], usage: null };
    if (channel === "shell:session-transcript") return [];
    if (["shell:model-default", "shell:session-selection", "shell:session-usage", "shell:provider-usage"].includes(channel)) return null;
    if (channel === "shell:open-external") {
      assert.equal(args[1], sourcePath);
      externalRead = args[1];
      return { kind: "standalone", path: sourcePath, content };
    }
    return [];
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(root, "out/preload/index.js"), contextIsolation: true, sandbox: true } });
  const wc = win.webContents;
  wc.on("console-message", (_event, level, message) => { if (level >= 2) console.error("renderer:", message); });
  const requests = [];
  const controller = new DevToolsController(async (file, title) => {
    const resolved = await resolveAppSource(root, file, title);
    requests.push({ file, resolved });
    return resolved;
  });
  controller.attach(wc);
  await win.loadFile(path.join(root, "out/renderer/index.html"));
  await wait(() => healthChecked, "renderer subscription");
  wc.send("shell:message", { kind: "session", session });
  await wait(() => wc.executeJavaScript('Boolean(document.querySelector(".sidebar-brand"))'), "Mira sidebar").catch(async error => {
    console.error(await wc.executeJavaScript('document.body.innerText'));
    throw error;
  });
  wc.openDevTools({ mode: "bottom" });
  await wait(() => wc.devToolsWebContents && !wc.devToolsWebContents.isLoading(), "DevTools");
  const point = await wc.executeJavaScript('(()=>{const r=document.querySelector(".sidebar-brand").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  wc.inspectElement(point.x, point.y);
  const dt = wc.devToolsWebContents;
  const clickRule = "(" + function(sourceLine) {
    function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
        if ((el.getAttribute("title") || "").endsWith("/_sidebar.scss:" + sourceLine)) { el.click(); return true; }
      }
      return false;
    }
    return walk(document);
  }.toString() + ")(" + line + ")";
  await wait(() => dt.executeJavaScript(clickRule), "mapped Styles link");
  await wait(() => externalRead === sourcePath, "editor source read");
  await wait(() => wc.executeJavaScript('Boolean([...document.querySelectorAll(".tab.active")].find(el => el.title === ' + JSON.stringify(sourcePath) + '))'), "active stylesheet tab");
  await wait(() => wc.executeJavaScript('Boolean(document.querySelector(".monaco-editor .view-lines")?.textContent.includes("sidebar-brand"))'), "Monaco source at rule");
  assert.equal(requests.at(-1).resolved, sourcePath);
  console.log('[electron-devtools-smoke] ' + JSON.stringify({ stylesLinkOpenedEditor: true, source: sourcePath, line }));
  wc.closeDevTools();
  clearTimeout(watchdog);
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
`;
try {
  await build({ stdin: { contents: source.replace("CONTROLLER", JSON.stringify(path.join(root, "src/main/devtools-controller.ts"))).replace("RESOLVER", JSON.stringify(path.join(root, "src/main/source-resolver.ts"))).replace("ROOT", JSON.stringify(root)).replace("PROFILE", JSON.stringify(path.join(temporary, "profile"))), resolveDir: root }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry });
  const child = spawn(electron, [entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { output += chunk; process.stderr.write(chunk); });
  const timeout = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timeout);
  if (code !== 0 || !output.includes('"stylesLinkOpenedEditor":true')) throw new Error(`DevTools smoke failed with exit ${code}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
