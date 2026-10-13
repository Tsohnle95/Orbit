#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const repository = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--ref")) throw new Error("Usage: node scripts/benchmark-renderer-store.mjs [--ref <commit>]");
const supportedNode = readFileSync(path.join(repository, ".node-version"), "utf8").trim();
if (process.versions.node !== supportedNode) throw new Error(`Use Node ${supportedNode}; active version is ${process.versions.node}`);
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const ref = args[1] ? git("rev-parse", "--verify", `${args[1]}^{commit}`) : null;
const files = ref ? new Set(git("ls-tree", "-r", "--name-only", ref, "src").split("\n")) : null;
const plugins = ref ? [{
  name: "historical-store-source",
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (entry) => {
      const directory = entry.namespace === "git-source" ? path.posix.dirname(entry.importer)
        : path.relative(repository, entry.resolveDir).split(path.sep).join("/");
      const modulePath = entry.path.startsWith("@shared/") ? `src/shared/${entry.path.slice(8)}`
        : entry.path.startsWith(".") ? path.posix.normalize(path.posix.join(directory, entry.path))
          : path.isAbsolute(entry.path) ? path.relative(repository, entry.path).split(path.sep).join("/") : null;
      if (!modulePath?.startsWith("src/")) return { path: entry.path, external: true };
      const resolved = [modulePath, `${modulePath}.ts`, `${modulePath}.tsx`, `${modulePath}.js`, `${modulePath}/index.ts`]
        .find((candidate) => files.has(candidate));
      if (!resolved) throw new Error(`Missing ${modulePath} at ${ref}`);
      return { path: resolved, namespace: "git-source" };
    });
    builder.onLoad({ filter: /.*/, namespace: "git-source" }, (entry) => ({
      contents: git("show", `${ref}:${entry.path}`), loader: entry.path.endsWith(".tsx") ? "tsx" : "ts"
    }));
  }
}] : [];
const built = await build({
  stdin: { contents: 'export { StoreProvider, useStore } from "./src/renderer/src/store.tsx"; export { largeSessionEvents, retainedOutputChars } from "./src/renderer/src/large-session-fixture.ts";', resolveDir: repository },
  bundle: true, platform: "node", format: "cjs", write: false, jsx: "automatic", packages: "external",
  alias: { "@shared": path.join(repository, "src/shared") }, plugins
});
const require = createRequire(path.join(repository, "package.json"));
const compiled = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(require, compiled, compiled.exports);
const { StoreProvider, useStore, largeSessionEvents, retainedOutputChars } = compiled.exports;
const React = require("react");
const { createRoot } = require("react-dom/client");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function sample() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://fixture.local" });
  for (const name of ["window", "document", "HTMLElement", "localStorage"]) globalThis[name] = dom.window[name];
  let handler, store, renders = 0;
  const session = { id: "session", directory: "/fixture", workspace: { id: "11111111-1111-4111-8111-111111111111", generation: 1 } };
  const empty = async () => [];
  window.openshell = {
    platform: "darwin", onMessage: (callback) => { handler = callback; return () => { handler = null; }; },
    health: async () => true, takePendingPaths: empty, state: async () => null, activeSessions: empty,
    models: empty, modelDefault: async () => null, sessionSelection: async () => null, agents: empty, sessions: empty,
    openSession: async () => session, openSessionById: async () => ({ session, transcript: [], todos: [] }),
    closeSession: async () => {}, readFile: async () => "", listDir: empty, listPermissions: empty,
    runtimes: empty, projects: empty, providerUsage: async () => null,
    savedWorkspaces: async () => ({ initialized: true, workspaces: [] }), saveSavedWorkspaces: async () => {},
    sessionUsage: async () => null, sessionTranscript: async () => ({ transcript: [], todos: [] }),
    inboxList: empty, formsList: empty, recoveryList: empty, reportUnsavedEditorFiles: () => {}
  };
  function Probe() { store = useStore(); renders++; return null; }
  const root = createRoot(document.querySelector("#root"));
  try {
    await React.act(async () => root.render(React.createElement(StoreProvider, null, React.createElement(Probe))));
    let start = performance.now();
    await React.act(async () => store.addModelPanel("/fixture"));
    const openMs = performance.now() - start;
    await React.act(async () => {
      for (const event of largeSessionEvents(100)) handler({ kind: "event", type: event.type, data: event });
    });
    const emit = (type, data, id) => handler({ kind: "event", type, data: { id, created: Date.now(), data: { sessionID: session.id, ...data } } });
    await React.act(async () => {
      emit("session.step.started", { assistantMessageID: "zz-tail" }, "start");
      emit("session.text.started", { assistantMessageID: "zz-tail", ordinal: 0 }, "text");
    });
    const previousRenders = renders;
    start = performance.now();
    for (let index = 0; index < 100; index++) {
      await React.act(async () => emit("session.text.delta", { assistantMessageID: "zz-tail", ordinal: 0, delta: " token" }, `delta-${index}`));
    }
    const streamingMs = performance.now() - start;
    const assistants = store.transcript.filter((item) => item.kind === "assistant");
    const outputChars = retainedOutputChars(store.transcript);
    if (assistants.length !== 101 || outputChars !== 100 * 32768 || assistants.at(-1).parts[0].text !== " token".repeat(100)) throw new Error("Benchmark transcript content changed");
    return { openMs, streamingMs, updateRenders: renders - previousRenders, assistantCount: assistants.length, outputChars };
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
}
for (let index = 0; index < 3; index++) await sample();
const samples = [];
for (let index = 0; index < 9; index++) samples.push(await sample());
const distribution = (field) => {
  const sorted = samples.map((sample) => sample[field]).sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[4], max: sorted[8] };
};
console.log(JSON.stringify({
  source: ref ?? "working tree", head: git("rev-parse", "HEAD"), node: process.version,
  bundleSha256: createHash("sha256").update(built.outputFiles[0].text).digest("hex"),
  scope: "Actual Store event processing and React/jsdom context consumer commits; mocked bridge; excludes filesystem, IPC, provider latency, Chromium layout and paint",
  workload: { assistants: 100, setupEvents: 600, toolOutputChars: 32768, deltas: 100, warmups: 3, samples: 9 },
  openMs: distribution("openMs"), streamingMs: distribution("streamingMs"), samples
}, null, 2));
