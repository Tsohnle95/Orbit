# Architecture

> **Document role:** canonical owner for cross-process architecture and durable architectural invariants. Module docs may summarize or route here but should not redefine these invariants.

Orbit is an Electron app built with **electron-vite** (three build
targets: `main`, `preload`, `renderer`). It is a GUI for the opencode2
agent: you open a repository, send a prompt, and watch the agent stream
its work while live diffs of changed files appear in the editor.

## Process model

```
┌─────────────────────────────────────────────────────────────┐
│ Electron MAIN (src/main/index.ts)                           │
│  • creates the BrowserWindow                                │
│  • owns OpenShellBackend (src/main/opencode.ts)             │
│  • registers shell:* IPC handlers                            │
│  • is the ONLY process that talks to opencode2              │
└──────────────┬───────────────────────────┬──────────────────┘
               │ ipcRenderer.invoke()      │ webContents.send()
               │ (renderer → main)         │ (main → renderer)
               ▼                           ▼
┌──────────────────────────┐   ┌─────────────────────────────┐
│ PRELOAD (src/preload)    │   │ RENDERER (React 19 + Monaco)│
│ contextBridge:           │   │  • store.tsx = all UI state │
│ window.openshell API     │   │  • components render it     │
└──────────────────────────┘   └─────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ opencode2 service (spawned via Service.ensure or existing)  │
│  • SSE event stream (client.event.subscribe)                │
│  • REST: session/file/model/project/permission endpoints    │
└─────────────────────────────────────────────────────────────┘
```

## Backend connection

`OpenShellBackend.connect()` in `src/main/opencode.ts`:

1. Probes `opencode2 --version` and derives a compatibility predicate: a
   registered service must match the installed build and clear
   `minSupportedServerBuild`. A daemon left running from a previous install
   would otherwise still satisfy the floor, so matching the installed build is
   what makes an upgrade visible after Orbit restarts.
2. `Service.discover()` — finds an already-registered opencode service whose
   version satisfies the predicate.
3. Falls back to `Service.ensure({ command: ["opencode2", "serve", "--service"] })`,
   which terminates a version-mismatched daemon, spawns the service, and waits
   for it to be ready.
4. Creates a typed client: `OpenCode.make({ baseUrl, headers })`.
5. The `runEventLoop()` SSE loop runs through the `createStreamPipeline`
   transport (`src/main/stream-pipeline.ts`): 33ms per-directory batched
   flushing with delta coalescing and snapshot barriers, a 30s heartbeat, and
   exponential reconnect backoff; `connect()` is retried every 2s until a
   client exists, and three consecutive stream failures release the client so
   the loop rediscovers or ensures a live service without an app restart.

## Runtime adapter boundary

The normalized adapter contract starts in
`src/main/runtimes/runtime-adapter.ts`. `RuntimeManifest` uses Orbit
protocol version 1, a stable runtime id, runtime version, availability, and an
explicit capability bitmap. Session records carry `runtimeID`; its optional
shape is the migration path for OpenCode sessions created before runtime
identity existed, which resolve to OpenCode when they enter the runtime
manager.

The first non-OpenCode implementation is the built-in DeepSeek Harness adapter
under `src/main/runtimes/deepseek/`. It targets the verified `dsh` rc.7 native
contract: correlated request/response envelopes over loopback HTTP and the
independent mux and host WebSocket downlinks required by `dsh web`. The carrier accepts only unauthenticated
loopback HTTP URLs, sends an explicit loopback Host authority, refuses
redirects and non-JSON/HTML RPC responses, bounds response/frame sizes, checks
every echoed `rpcId`, and preserves native business error codes. The two WebSocket
streams reconnect independently and replayed frames are deduplicated by
`rpcId`. The adapter can launch `dsh web --host 127.0.0.1 --port 0 --no-open`
in a workspace, reads only its explicit startup URL line, and terminates the
owned process on shutdown.

DeepSeek history is projected from its provider-neutral `user/message`,
`assistant/message`, `tool/call`, `tool/result`, and `todo/write` records into
the shared transcript. Live `step/*`, `assistant/chunk`, `assistant/message`,
`tool/*`, and `llm/retry` records enter the same ordered streaming vocabulary
used by OpenCode. Text, reasoning, and tool arguments append through the
shared renderer store while final records authoritatively reconcile streamed
parts. Native Tool call/result views remain attached as provider metadata so
the timeline can honor terminal, read, search, web, and diff intent without
inferring a weaker approximation. Code-dispatch start/result records remain
nested beneath their root call and use the same themed Tool renderer at every
depth. Prompt submission does not poll or repeatedly
hydrate history; snapshots are reserved for open, materialization, and
reconnect recovery. Its manifest currently advertises only implemented
features: model selection and session resume. Attachments, commands, steering,
agent presets, approval responses, provider credential editing, and forking
remain disabled until their normalized adapter methods and UI paths exist.
Renderer IPC carries only runtime manifests, selected runtime ids, and the
existing normalized session operations; native DeepSeek envelopes and service
URLs remain main-process-only.

Runtime selection is persisted in renderer preferences and passed through the
folder/session-open boundary. Each active workspace context retains its
adapter and `runtimeID`; workspace watching, editing, recovery, and terminals
stay in core while prompts, history, interruption, models, and event streams
route to the selected adapter. DeepSeek session id/directory/runtime mappings
are atomically persisted in the main-process runtime session index, allowing a
cold app restart to launch `dsh web` in the correct workspace and reopen the
native session. UI controls are hidden when their manifest capability is false.

## Message flow

All backend→renderer message kinds are defined in
`src/shared/types.ts` (`BackendMessage`):

- `{ kind: "event", type, data }` — every opencode2 SSE event forwarded
  through the main-process transport pipeline (coalesced per directory and
  flushed in 33ms batches). The renderer dispatches on `type`. See
  `docs/events.md` for the full protocol map.
- `{ kind: "file-update", file: { workspace, sessionID, path, baseline, content, deleted } }` —
  emitted by the generation-bound fs watcher (below).
- `{ kind: "session", session: { id, directory, workspace } }` — emitted when a
  session context activates (a new concurrent panel).
- `{ kind: "recovery", recovery: { workspace, records } }` — durable artifact
  inventory emitted on activation and transaction/acknowledgment changes.
- `{ kind: "terminal-data" | "terminal-exit", terminal }` — PTY output /
  exit from the terminal tray (`src/main/terminal.ts`).
- `{ kind: "ui-command", command }` — main-process requests to the
  renderer (`toggle-word-wrap` when ⌘W / Ctrl+W is pressed;
  `open-source` with `{ path, line }` when a CSS rule's source link
  is clicked in DevTools — `path` is a canonical app-root-confined absolute
  path opened at that line as a standalone tab when outside the active workspace).

Renderer→main is synchronous invoke over `shell:*` channels; the full
table is in `docs/main.md`.

Prompt failures are normalized through `src/shared/errors.ts`. Submission
rejections preserve native codes when available or receive a stable `ORBIT_*`
code; runtime, stream, malformed-event, and event-handler failures are forwarded
as structured session/global events so the renderer can retain both the message
and code.

## Renderer trust boundary

The application window is explicitly sandboxed with context isolation and no
Node integration. Its privileged preload bridge is protected in main: every
IPC invoke must come from the active window's main frame while it is at the
exact packaged application document or an approved loopback HTTP development
origin. Packaged startup ignores `ELECTRON_RENDERER_URL` and always loads the
bundled file.
Unexpected main-frame navigation and redirects are canceled, and all popup
creation is denied. Markdown and tool attachment anchors prevent same-frame
navigation and request an external popup instead. Main opens only absolute,
credential-free `https:` URLs through the operating system; local files,
custom schemes, malformed targets, and insecure HTTP targets are rejected.

## Session lifecycle

1. User picks a folder (renderer → `shell:select-folder` / `shell:open-session`).
   Main accepts the renderer generation before a native dialog opens, so a
   later user action wins even if an earlier dialog resolves later.
2. `openSession(directory)` creates the session via
   `client.session.create({ location: { directory } })` — opencode's own
   defaults pick the model and agent; canonicalizes the workspace root,
   assigns a fresh immutable workspace identity, and starts the context's
   fs watcher.
3. Emits `{ kind: "session" }`; the renderer replaces the displayed panels
   with the selected session and focuses it. Reopening an already-open session
   reuses its context (stable workspace identity, no re-emit) and the renderer
   just focuses the panel. Model mode's explicit `+` action is the additive
   path.
4. Prompts go through `client.session.prompt({ sessionID, text, files? })`;
   interrupt through `client.session.interrupt`.
5. The backend owns any number of concurrent session contexts at once, each
   with its own watcher, snapshots, and recovery state. Every `shell:*`
   invoke addresses one workspace identity, resolved against the context map.
   One global SSE loop feeds all sessions; events route by session id and
   `filesystem.changed` fans out to every context on the reported directory
   (the reported path is realpath-canonicalized before matching, so
   symlinked or case-differing roots reach the right context).
6. Closing a panel invokes `shell:close-session`: main stops that context's
   fs watcher and removes it from the context map (the opencode session
   itself stays alive so recents can reopen it), and reopening the session
   later activates a fresh context with a fresh workspace identity. A workspace
   replacement detaches a panel without closing its context while that session
   is busy; the renderer reconciles `activeSessions()` every second so the
   background run remains in **Open now** and can be reopened or explicitly
   closed.
7. `window-all-closed` quits on every platform. `before-quit` aborts the active
   SDK SSE subscription, stops every context watcher, and tears down terminals.
   A renderer reload does not close the backend process; the renderer merges
   its versioned `orbit.sessionLayout` restart hints with `activeSessions()`,
   reopens panels silently through the existing session-by-id path, and focuses
   the saved panel when it remains valid and the user has not acted. A full
   process restart has no live backend contexts, so the renderer uses the same
   hints to reopen persisted session IDs in order, carrying an optional runtime
   ID while main re-resolves the session directory and mints fresh workspace
   identity. Malformed, stale, moved, or runtime-unavailable entries are
   independently discardable and never block launch; transient editor,
   terminal, permission, queue, prompt, and capability state is not recreated.
   Dock `activate` can re-create a window only while the process is still alive
   (for example after programmatic window destruction), not after the
   last-window quit path.

## Diffs and baselines (how the diff view works)

The Changes list represents workspace file changes observed during the active
session, regardless of whether they came from a tool, shell, editor, formatter,
user, or another process. Main preserves the first baseline per path until Git
metadata changes, then refreshes the effective Git baseline:

- **Tool snapshot**: when `session.tool.called` arrives, every file path
  found in the tool input (keys `filePath`/`file_path`/`path`) is read and
  stored as that file's baseline *before* the tool executes.
- **git fallback**: files first observed via `fs.watch` use
  `git show HEAD:<rel>` in a Git workspace; untracked Git paths use a known
  empty baseline with `exists: false`. A Git HEAD result, including empty
  content, represents an existing file.
- **unknown fallback**: first-observed non-git changes have an explicit unknown
  baseline because the watcher only has post-change bytes.
- **Orbit mutations**: saves and creates establish a known baseline only
  when none exists. Delete and rename preserve the established baseline.
- **Live watching**: one recursive `fs.watch(directory, { recursive: true })`
  per open context captures the activation root/session/identity and
  workspace-scoped maps, then feeds every change through a 200ms debounce into
  `onFsChanged`, which compares against `lastKnown`, assigns a baseline if
  missing, and emits identity-bound `file-update` with `{baseline, content}`.
  Git metadata events use the same debounce to refresh tracked snapshots;
  files equal to their known baseline, and deleted paths with `exists: false`,
  leave Changes, while files still differing remain listed.
  Await boundaries and emissions re-check that the context is still
  registered.

The renderer merges updates into tabs and removes clean file updates from
Changes. A known baseline enables Monaco Diff;
an unknown baseline stays in Changes as `observed` with Diff unavailable.

This is observation, not attribution. Structured tool paths can be captured
before execution, but arbitrary shell command strings are not parsed for paths,
and Git `HEAD` does not identify an author. Skipped directories (`.git`,
dependencies, caches, IDE metadata, and build outputs), unreadable/binary files,
watcher coalescing, pre-activation changes, and missed first notifications can
prevent observation or recovery of pre-change content.

### Native revert and VCS queries (v2 contract)

The server now owns undo checkpoints: `session.revert.stage` stages a rollback
at a message (optionally including file changes), `commit` applies it, and
`clear` discards the stage; Orbit surfaces this as a hover "Revert from here"
action on completed assistant turns plus a staged-undo dock card. The v2
contract also exposes `vcs.get`, `vcs.status`, and `vcs.diff` per location.
These are candidates to replace the local `git show HEAD:` baseline heuristic
because they understand staged/untracked/merge state, but adopting them means
re-running the watcher-phase tests against a new source; keep that as its own
change rather than mixing it into feature work.

## Editing and saves

The renderer is fully editable. Each edit increments its tab revision and
autosave captures the exact workspace, path, content, expected disk content,
and revision after a 900ms debounce; ⌘S saves immediately. Saves serialize
per workspace/file in the renderer and all filesystem mutations serialize per
workspace in main; identified echoes clear only matching state.
Normal writes require the disk to still equal the last saved content. External
updates preserve local edits and pause saving until explicit reload, overwrite,
or keep-editing then save-merged resolution. Lifecycle changes invalidate
timers and stale completions; external updates advance a conflict generation so
an already-started completion cannot clear a newer conflict. Writes create a
transaction under workspace-local `.openshell-recovery`, copy proposed bytes
into a second durable artifact, move the current target inode into the
transaction, validate the held bytes, and install the temporary inode with a
no-replace hard link. The original pathname is briefly unavailable between the
hold and install. A concurrent recreation is never overwritten. Neither success
nor rollback unlinks the held original inode, so later writes through an
already-open descriptor remain visible in the recovery artifact. Proposed bytes
remain durable. Phase metadata is atomically replaced and fsynced; activation
restores the held original only for interrupted `source-held` or
`held-validated` transactions and only when the canonical path is missing,
never over an existing path. Completed, failed, and acknowledged history never
replays. Successful transactions are acknowledged automatically while their
bytes remain retained; abnormal transactions remain visible until acknowledged.
Acknowledge persists metadata only and never deletes bytes. Activation runs a
best-effort retention purge that removes settled transactions (`complete`,
`failed`, acknowledged) older than 24 hours and interrupted ones
(`source-held`, `held-validated`) older than 7 days; fresh transactions are
never purged. This protocol requires recovery and target names to share a
filesystem. Writes go through Node `fs` in the main process
(`shell:fs-write`); the opencode2 API has no write
endpoint — the server sees the change via its own file watching. The
explorer also supports create/file-rename/delete through `shell:fs-create-*`,
`shell:fs-rename`, `shell:fs-delete` (delete moves to Trash). File rename uses
same-filesystem no-replace hard-link/unlink semantics. Portable Node filesystem
APIs cannot guarantee no-replace directory rename, so directory rename is
rejected rather than recursively copying and deleting a potentially changing
source tree. File rename moves the source into a durable hold before linking the
no-replace destination. Rollback only links back into an absent source and never
unlinks the hold, preserving ambiguity when another process recreates the
source. These operations run through the same watcher so baselines and the tree
stay consistent.

Drag-and-drop moves (`shell:fs-move`) deliberately deviate from the
hold/link recovery dance: a directory cannot be moved as a held single
inode the way a file can, and recursive copy-into-recovery would invite
concurrent-mutation races. `movePath` instead performs one atomic
`fs.rename` after re-checking the destination (never replacing an
existing path), so a failed move leaves both the source and destination
untouched and no recovery transaction is recorded. Cross-filesystem
`EXDEV` failures are rejected as errors rather than falling back to a
copy. The backend emits a tracked deletion at the source and, for files,
an addition carrying the captured baseline at the target; files inside a
moved directory surface through the fs watcher, and the renderer
re-lists both the old parent and the destination. The source/target
confinement rules are identical to the other mutations, and
`.openshell-recovery` is rejected as both source and destination.

Every workspace filesystem call carries the expected workspace UUID and main
rejects stale generations. Paths are bounded strict relative paths and no
existing symlink component may be traversed, including an intermediate parent
of a new target. This assumes stable topology during the operation; Node
pathname APIs cannot fully prevent an external symlink swap after validation.
Absolute reads are not part of the workspace API. DevTools CSS navigation
resolves only app-root-confined sources in main, then uses the same explicit
external-file capability as a user-opened standalone file.

`.openshell-recovery` is excluded from watching, Explorer, and application file
references. The recovery root, transaction directories, artifacts, and
canonical recovery parents must contain no symlink component. Transaction ids
and manifests are validated, and Open resolves a known artifact id in main
rather than accepting a renderer path. Recovery reconciliation is activation-
generation guarded before filesystem mutation.

## Models, agents, and composer controls

Each session panel's header has two pickers. Models come from
`client.model.list()` (filtered to `{ id, providerID, name, variants }`) and
are grouped by provider in the composer menu. The current model is seeded
from `client.model.default()` per panel and updated live by
`session.model.selected` for the addressed session.
Switching calls `client.session.switchModel({ sessionID, model })`, including
`model.variant` when a model exposes response-strength variants.
Provider settings are adapter-backed rather than OpenCode-specific UI. The
current adapter maps `integration.list` into secret-free shared types and sends
write-only keys through `integration.connect.key`; credential changes refresh
the workspace model catalog. A featured top-20 ordering is renderer-only, while
search exposes every integration supplied by the active runtime.
Agents come from `client.agent.list()`; the selection is updated live by
`session.agent.selected` and switched via
`client.session.switchAgent({ sessionID, agent })`. Both choices are
session-scoped only: a new session starts on opencode's configured defaults
(`default_agent` / default model), and Orbit never writes preferences of
its own. The composer
also opens a native multi-file picker; the main process converts selected
files to `file://` URIs for the prompt API. Its approval toggle is local UI
state: approve mode automatically replies `once` to each permission request.
Voice input uses the Chromium Speech Recognition API when the Electron build
provides it.

## Terminal tray

The bottom tray (`src/main/terminal.ts` + `TerminalTray.tsx`) and the optional
agent TUI panel (`AgentTui.tsx`) run real PTYs via `node-pty`. Main resolves the workspace identity and supplies the
addressed workspace's canonical directory as cwd rather than accepting one
from the renderer. The tray belongs to the focused panel: switching focus
boots a fresh terminal for that workspace and stops the previous panel's
PTYs; `stopAll()` runs only at quit.
It spawns the selected shell in that directory and forwards PTY
output to the renderer as `terminal-data` messages; keystrokes go back
via `shell:terminal-input`. Resizes are handled with the xterm `fit`
addon + `shell:terminal-resize`. The tray is toggled from the titlebar
(⌥O), its height is drag-resizable, and dragging the divider to the
window bottom closes it on mouse release rather than mid-drag.
Terminal ids, ownership, input size, and bounded positive dimensions are
validated before operations reach `node-pty`.
The selected shell is the user's normal interactive shell, not a login shell.
The locked Node-API-based `node-pty` is exercised under Electron on macOS,
Linux, and Windows CI.

An agent panel can switch from GUI to TUI from its header mode pill. The main
process resolves the active session's runtime command and starts it with the
session directory as cwd; OpenCode launches `opencode2 --session <session-id>`.
The renderer keeps the TUI inside the panel with xterm.js and reuses the
terminal data, resize, ownership, and cleanup paths. DeepSeek advertises no TUI
capability until a supported profile is available. The Kitty Glass appearance
profile uses the same embedded terminal with alpha surfaces, native macOS
under-window vibrancy, and Kitty-inspired colors; it does not open an external
terminal window.

## Permissions

When opencode2 needs approval it emits `permission.asked`. The renderer
shows a card with the action and resources and three buttons; the reply
(`once` | `always` | `reject`) goes through
`client.permission.reply({ sessionID, requestID, reply })`.

## Key constraints

- The renderer never touches Node APIs (contextIsolation + no
  nodeIntegration); everything goes through `window.openshell`.
- `SKIP_DIRS` (main) and `HIDDEN_DIRS` (renderer) filter tree noise
  (`node_modules`, `.git`, build dirs). `listDir` reads directories
  directly with `fs.readdir` (no opencode round trip), so explorer
  refreshes never depend on service latency.
- `MAX_EDITABLE_BYTES` (4 MiB) and a NUL-byte check keep binary/huge
  files out of the editor.
