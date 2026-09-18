# Operations: running, verifying, and debugging

> **Document role:** canonical owner for running, verification, smoke testing, operational debugging, and recovery procedures.

Practical know-how for running the app, smoke-testing it, and debugging
renderer/main behavior without guessing. Everything here has been used
and verified in real sessions.

## Prerequisites

- Node 22.23.2 and npm. `.node-version`, `package.json` engines, and CI select
  the supported Node 22 range starting at 22.23.2, which satisfies the full
  locked dependency graph.
- `opencode2` on PATH (checked with `which opencode2`). The app connects
  via `Service.discover()` and falls back to spawning
  `opencode2 serve --service` itself, so a service is not strictly
  required to be running beforehand.

## Running

```sh
npm run dev      # electron-vite dev with HMR (main/preload/renderer)
npm test         # Vitest unit/component tests in jsdom
npm run test:platform # launcher tests and real Electron-hosted PTY smoke
npm run build    # compile then launch the production app (one command)
npm run build:compile # compile only -> out/ (no launch)
npm run pack     # build + package a real macOS app -> release/mac/Orbit.app
npm run install-app # build + package + install Orbit.app into /Applications (macOS)
npm run check    # typecheck, tests, docs check, and compile-only build
npm start        # launch the existing production build with electron-vite preview
```

`npm run build` compiles into `out/` and immediately launches the result;
`npm run build:compile` is the compile-only form (used by CI and `npm run
check`) and `npm start` launches an existing build without rebuilding. The
portable Node launcher prepares and selects the branded app bundle on macOS and
uses plain Electron on Linux and Windows, without shell-specific environment
syntax. After a manual build you can also launch with `npx electron .`.
`npm run pack` and `npm run install-app` are macOS-only: both run
`scripts/install-app.mjs`, which builds `out/`, packages the app with
electron-builder (`electron-builder.yml`, `asar: false`, unpacked
`Contents/Resources/app` layout), and ad-hoc re-signs the bundle;
`install-app` then replaces `/Applications/Orbit.app` (removing any
existing copy first, `cp -R` preserving the signature). The installed bundle is
a live launcher: `scripts/install-app.mjs` strips the packaged `out/`,
`node_modules/`, and `resources/` payload and replaces it with
`scripts/live-launcher.cjs` plus a two-line `package.json`, so the app keeps
its own Electron runtime and Dock icon but loads the main process from the
repository's `out/`, rebuilding automatically first when repository sources are
newer than the build (silently; if the rebuild fails it falls back to the last
known good build after confirming). On macOS,
`npm run install-app` drives the same script over the
`shell:install-app` channel. `release/` and
`build/` are gitignored builder outputs.
`npm run test:platform` also runs the hidden-window renderer trust smoke on
macOS. Linux and Windows run the launcher and Electron PTY coverage but skip the
GUI smoke because a normal `BrowserWindow` requires a display there; macOS CI is
the targeted GUI lifecycle host. The trust smoke uses the built main process,
bundled preload, local packaged renderer, and a local `data:` document. It
checks trusted IPC, same-frame external navigation denial, popup denial, and
untrusted-document IPC rejection without external network access. `npm run typecheck`
runs `tsc --noEmit` for both node and web configs. `npm run check` is the
canonical local and CI verification gate.

The platform smoke scripts fail boundedly: the direct PTY and Electron-hosted
PTY checks have 10-second child watchdogs, the Electron parent kills the full
child process tree on timeout, and the macOS trust check has a 30-second
watchdog. The GitHub Actions platform-smoke job also has a 10-minute job
timeout so a native-process failure cannot leave CI running indefinitely.

Orbit is macOS-first with supported development/runtime launch on macOS,
Linux, and Windows. CI runs launcher configuration tests and a real
Electron-hosted `node-pty` input/output/exit smoke on all three. This verifies
the native module and shell path but is not a GUI smoke test; window behavior
still requires the human checklist below. Terminals use the user's normal
interactive shell (`SHELL`, `COMSPEC`, or the platform default), not login mode.
This matches integrated-terminal expectations and avoids re-running login
session initialization for every tab. `node-pty` 1.1.0 uses Node-API, and the
Electron-hosted smoke verifies the locked binary directly, so no
`@electron/rebuild` lifecycle is required. The portable `postinstall` only
restores execute permission on node-pty's packaged macOS `spawn-helper`, which
the npm tarball does not preserve; Linux uses node-pty's direct `forkpty`
implementation and does not need that helper.

## Updating the OpenCode client

`@opencode-ai/client` is pinned to an exact prerelease. The pinned contract and
the installed `opencode2` binary drift independently: the binary is whatever is
on PATH (or an already-running service), while the compile-time contract moves
only when this procedure runs. Run `npm run client:drift` on a weekly cadence —
and before adopting any new protocol feature — to compare the pin against the
published `beta`, `next`, and `dev` lines; it exits nonzero when beta is ahead.

The runtime binary is not pinned. On every connect Orbit probes
`opencode2 --version`, accepts a registered service only when its build matches
that installed build and clears `minSupportedServerBuild`, and otherwise asks
`Service.ensure` to terminate the mismatched daemon and spawn the new binary.
The binary is whatever `PATH` resolves, so upgrading the CLI in a terminal and
restarting Orbit is enough to move to the new server; no pin change is needed.

When the event contract moves, raise
`minSupportedServerBuild` in `src/main/opencode.ts` so discovery and
`Service.ensure` refuse servers too old to speak it; the predicate receives the
service's reported version string. Update it only in an explicit dependency
commit:

1. Run `npm install --save-exact @opencode-ai/client@<version>` on the supported
   Node version and review that the lockfile changes only the intended client,
   protocol, schema, and necessary transitive packages.
2. Review generated client method signatures used by `src/main/opencode.ts`
   and service discovery/authentication imports. Adapt that isolation boundary
   deliberately rather than bypassing types.
3. Review protocol event changes against `docs/events.md` and the replay/event
   fixtures in the main and renderer tests. Add or update captured protocol
   fixtures for every changed event shape, including handled and intentionally
   ignored events.
4. Run `npm run check` and `npm run test:platform`. Exercise the human GUI smoke
   checklist when service or streaming behavior changed.

## Usage data plugin (prototype)

`plugin/orbit-usage.ts` is an OpenCode plugin that runs inside the OpenCode
server process. It resolves active provider connections through the supported
integration API (`ctx.integration.connection.active/resolve`) instead of Orbit
reading OpenCode's credential storage directly, fetches ChatGPT and Claude
usage, and writes `{generatedAt, results}` — `results` matching
`ProviderUsageResult[]` — to `${XDG_DATA_HOME ?? ~/.local/share}/opencode/orbit-usage.json`
(override with `ORBIT_USAGE_SNAPSHOT`). `fetchProviderUsage()` in
`src/main/provider-usage.ts` always requests live data for credentials it can
resolve and uses a snapshot younger than 15 minutes only as a per-provider
fallback. This keeps explicit refreshes live without losing plugin-supplied
providers when direct credential resolution is unavailable.

Install it by copying (or symlinking) the file into OpenCode's global plugins
directory or listing its path under `plugins` in `opencode.json(c)`, then
restart the service; verify the snapshot file appears within a few minutes.
The prototype covers two providers; porting the remaining adapters from
`provider-usage.ts` and eventually deleting the scraping path is tracked as
follow-up work.

## Large-session benchmark

Run the deterministic renderer fixture independently with:

```sh
npx vitest run src/renderer/src/large-session.performance.test.ts --reporter=verbose
```

The JSON lines report reducer/update latency, derived timeline latency, an
estimated timeline-row proxy, retained output characters, and actual React/jsdom
rendering for 2,400 fixed events. On 2026-08-12,
before retention changes, the fixture measured 11.79 ms, 0.64 ms, 800 rows, and
26,214,400 retained characters. With retention enabled it measured 11.42 ms,
0.45 ms, 800 rows, and 3,276,800 retained characters. The test performs one
warmup and gates the median of five measured runs, reducing scheduler and JIT
noise seen in the full suite. Its deliberately generous CI budgets are a
100 ms median reducer/update time and 10 ms median derivation time. The
structural proxy budgets are at most 1,000 estimated rows and 8 KiB per completed
tool/shell result. The representative 400-turn timeline produces 800 actual
`data-timeline-row` DOM nodes. Its deliberately generous 5,000 ms budget covers
React reconciliation and jsdom DOM construction and is intended to catch gross
regressions without becoming machine-speed flaky. It explicitly does not
measure Chromium layout, paint, compositor work, or browser memory.
Compare trends using the same Node version and machine rather than treating the
median or jsdom timing as a cross-machine browser benchmark.

## Smoke test checklist

1. `which opencode2` — binary present.
2. `npm run build` (compiles then launches) with output captured to a log:
   `nohup npm run build > /tmp/orbit-smoke.log 2>&1 &`
3. After ~10s check the log for `[orbit]` console.error lines
   (`[orbit] event loop error:` means the SSE subscription failed).
4. Verify the backend spawned its service:
   `pgrep -fl "opencode2 serve"` and
   `lsof -nP -iTCP -sTCP:LISTEN | grep -i opencode`.
5. On macOS, verify the Electron window is alive:
   `pgrep -f "Orbit.app/Contents/MacOS/Electron"`. Use Task Manager or the
   platform process monitor on Windows/Linux.
6. GUI pass (needs a human): open a folder, send a prompt, confirm the
   agent dot turns green / titlebar says "working", text streams, tool
   cards appear with names and elapsed timers, and a file the agent
   touches shows a diff.

## Manual recovery

Orbit stores save and file-rename transactions in
`<workspace>/.openshell-recovery/`. Explorer and file watching intentionally
hide this directory. Each transaction contains `manifest.json` plus one or more
artifacts named `original`, `temporary`, `proposed`, or `source`. On
activation, Orbit purges settled transactions (`complete`, `failed`,
acknowledged) older than 24 hours and interrupted ones (`source-held`,
`held-validated`) older than 7 days. Younger artifacts are never removed
automatically, and Acknowledge never deletes bytes on its own.

1. Use the recovery notice's Open action to inspect each artifact.
2. Compare `originalPath`, the current canonical file, and the artifact before
   manually copying any bytes.
3. Use Acknowledge when review is complete. This updates `manifest.json` and
   hides the notice; it does not delete the artifact or directory.
4. If the UI cannot open the workspace, inspect the transaction directories
   directly. Do not remove them until applications that may retain old file
   descriptors have exited and the bytes have been reviewed. Once past the
   retention windows they are removed automatically on the next activation.

Activation may hard-link a held original back to a missing canonical path only
for an interrupted `source-held` or `held-validated` transaction, where
Orbit is known to have removed that path. It never overwrites an existing
path and never replays completed, failed, or acknowledged history. If both
canonical and recovery versions exist, manual comparison is required. Normal
successful transactions retain their bytes but are acknowledged automatically,
so they do not create persistent recovery notices; their transaction
directories are purged once past the 24-hour retention window.

## Driving the renderer headlessly (CDP)

The UI can be inspected and driven over the Chrome DevTools Protocol.
Launch with a debug port, then evaluate JavaScript in the page:

```sh
npx electron . --remote-debugging-port=9222
curl -s http://127.0.0.1:9222/json/list   # find the page target + ws url
```

Node script pattern (Node 22 has a global `WebSocket`):

```js
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json())
  .find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
// send { id, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue } }
// then read the matching { id } response from ws.onmessage
```

Useful expressions:

- `document.querySelectorAll('.agent-model option').length` — model dropdown state
- `window.openshell.openSession("/path/to/repo").then(JSON.stringify)` — open a session
  without clicking (the store reacts to the emitted `session` message)
- `getComputedStyle(...)`, `document.querySelector('.tree-row').innerText`,
  `[...document.querySelectorAll('.toast')].map(t => t.textContent)` — UI state checks

Caveat: `npm start` (electron-vite preview) does NOT forward
`--remote-debugging-port`; use `npx electron .` on the built output, or
`npm run dev` and attach to its window.

## Probing the opencode2 service directly

The service speaks JSON HTTP on a localhost port. Useful when the client
call "should work" but something fails — probe the raw API.

- Port: `lsof -nP -iTCP -sTCP:LISTEN | grep opencode2` (the `opencode2
  serve --service` process).
- Registration file: `~/.config/opencode/service.json` holds `password`.
- Auth: HTTP Basic, username `opencode`:
  `Authorization: "Basic " + btoa("opencode:" + password)`.
- Endpoints: `GET /api/model`, `GET /api/model/default`,
  `GET /api/fs/list?<query>`.
- **Query-serialization gotcha**: nested params use bracket notation —
  `location[directory]=/Users/ty/orbit`. A JSON-stringified
  `location={"directory":...}` is rejected with
  `Expected object | undefined, got string at ["location"]`. The
  `@opencode-ai/client` does this correctly itself
  (`appendQuery` in its generated code) — this only bites hand-rolled
  requests.

The client package can't be imported directly in plain Node ESM (it
emits extensionless imports for a bundler); probe with `fetch` instead.

## Known quirks worth remembering

- `model.list` / `model.default` accept an optional `location`; the app
  passes the session directory. Both work with 63 models enabled on the
  stock setup.
- The model dropdown only renders while a session is open (it gates on
  `session && models.length > 0`); it seeds `currentModel` from
  `model.default()` and live-updates from `session.model.selected`.
- Directory entries from `GET /api/fs/list` come with trailing slashes
  (`"src/"`); the backend normalizes them in `listDir` — the renderer
  must never receive raw entries.
- The renderer shows the Welcome screen on app launch (no session until a
  folder is opened); most agent-panel UI is session-gated.
- `session.tool.called` events carry NO tool name — names come from
  `session.tool.input.started` (see `docs/events.md`).
