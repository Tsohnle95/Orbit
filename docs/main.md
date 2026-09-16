# Module: main process

> **Document role:** canonical owner for main-process implementation ownership, backend behavior, and the `shell:*` IPC inventory.

`src/main/index.ts` (window + IPC wiring) and
`src/main/opencode.ts` (the `OpenShellBackend` — all opencode2 traffic).

`src/main/opencode.ts` is the only file that imports `@opencode-ai/client`.
Provider usage is a separate main-process integration with provider APIs in
`src/main/provider-usage.ts`.

`src/main/exec-path.ts` augments `process.env.PATH` once at startup. GUI-launched
macOS/Linux builds inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
user-installed runtimes in `~/.local/bin` and similar directories would
otherwise be invisible to the runtime `--version` probes that populate the
capability manifests (the embedded TUI and terminal tray), the
`Service.ensure` fallback, and every spawned PTY. The augmentation prepends the
conventional user tool directories without duplicating existing entries; Windows
GUI processes already inherit the user PATH and are left unchanged.

`src/main/runtimes/runtime-adapter.ts` defines the version-1 normalized runtime
contract and capability manifest. `src/main/runtimes/deepseek/` implements the
DeepSeek Harness rc.7 HTTP/WebSocket carrier, native session/model operations, event
deduplication, owned `dsh web` process lifecycle, and transcript projection.
Runtime-owned operations route through the adapter retained by each session
context; no native DeepSeek envelope or service URL crosses preload IPC.

## OpenShellBackend (`src/main/opencode.ts`)

State:

- `client` — `OpenCode.make()` result, null until connected
- `contexts` — a `Map<workspaceID, SessionContext>` of concurrently open
  sessions. Each `SessionContext` holds the immutable `WorkspaceIdentity`
  (`{id, generation}`), the session id, the canonical `directory`, the
  emitted `sessionInfo`, a workspace-scoped `watchContext` (`snapshots`,
  `lastKnown`, `hasGit`, debounce `timers`), the context's own `FSWatcher`,
  and a context-local `activations` generation guard for in-flight
  watcher/recovery work
- `primary` — the workspace id of the most recently activated context
- `stopped` and `eventLoop` — `start()` is single-flight, while stop aborts and
  invalidates the generation-owned SSE lifecycle before a later restart subscribes
- `activations` — monotonic token mint used for `WorkspaceIdentity.generation`
  and invalidated by `stop()`; each context additionally guards its own
  in-flight work
- `mutations` — serializes write/create/delete/rename operations per workspace

Every renderer-supplied `WorkspaceIdentity` is resolved through `contextFor`,
which looks the id up in `contexts` and rejects stale or unknown identities;
routing is per context instead of against a single active session. A context
is created per activation, and re-activating the same session id on the same
directory reuses the existing context (idempotent), keeping the workspace
identity stable so renderer editor state and file-update routing survive a
reopen.

Public methods (all used by IPC):

| Method | Purpose |
|---|---|
| `connect()` | `Service.discover()` → `Service.ensure({command:["opencode2","serve","--service"]})` → `OpenCode.make` |
| `start()` | Start the SSE event loop if one is not already running; unexpected loop failures are forwarded as structured `global.error` events |
| `stop()` | Abort and invalidate the active SSE loop lifecycle, then stop every context's fs watcher |
| `onMessage(cb)` | Subscribe to outbound messages; returns unsubscribe |
| `beginActivation(requestGeneration)` | Accept a renderer user action before native dialog/backend awaits and return a fresh backend generation token |
| `openSession(directory)` | Accepts a generation, calls `session.create`, and activates a new context (a new concurrent panel); starts the context watcher and emits `{kind:"session"}` |
| `openFileWorkspace(absolutePath, generation?, runtimeID?)` | Validates the path is a regular file, opens a session through the selected runtime on its parent directory (via `openSession`), and returns `{session, path}` so the renderer opens the file inside a true single-file workspace |
| `resolveExternalOpen(workspace, absolutePath)` | Resolves a dragged/dropped absolute path against the workspace root: inside-repo files come back as `{kind:"relative", rel, content}`, outside-repo files as a writable `{kind:"standalone", path, content}` (content size-capped, atomically readable) |
| `statExternal(absolutePath)` | Probes an absolute path (`file` / `directory` / `missing`) so a mixed file/folder drop can be routed: files open as standalone tabs, folders import into the workspace |
| `writeStandaloneFile(absolutePath, content, expectedContent, overwrite)` | Bounded atomic write (temp-file + rename in the file's own directory) for standalone tabs; rejects mismatched `expectedContent` unless `overwrite` |
| `importExternal(workspace, destDir, sources)` | Copies external files/folders into the workspace at `destDir` (per-workspace serialized, symbolically linked entries skipped, file/byte caps), seeding the watcher's known baselines so imported files never surface in Changes |
| `listSessions()` | `session.list` (paged, newest first) → `{id, title, directory, updatedAt, parentID?, agent?}`; hides sessions older than 30 days and sessions with no conversation (no title and zero token usage) |
| `activeSessions()` | The open contexts' `SessionInfo` in activation order, primary last (startup restore) |
| `closeSession(workspace)` | Tears down the addressed context (stops its watcher, removes it from the context map) when its panel closes; the opencode session itself stays alive so recents can reopen it |
| `deleteSession(sessionID)` | Closes the panel context when open, then permanently destroys the opencode session via `session.remove`; DeepSeek sessions are rejected (no delete RPC) |
| `openSessionById(sessionID, generation?, runtimeID?)` | Loads `session.get` plus replay; reuses the context when the session is already open (no re-emit), otherwise activates a new one. When a `runtimeID` is passed for a session whose native runtime differs and no context is active, remaps it to the requested runtime by opening the same directory (fresh native session) instead of the session's original runtime |
| `sessionTranscript(sessionID)` | Loads `message.list` replay as `{transcript, todos}` without activating a context; the renderer's stream materialization source |
| `sessionUsage(sessionID)` | Loads `session.get` and returns the normalized `SessionUsage` (`cost` + `tokens`) or `null` when unavailable (tokens missing — a missing `cost`, as with cost-less local providers, coerces to 0 so the snapshot stays refreshable); called after compaction to refresh the context-window display |
| `workspaceDirectory(workspace)` | Resolves a workspace identity to its canonical session directory (terminal cwd, identity validation) |
| `ptyDirectory(workspace)` | Working directory for a PTY in this panel: the captured workspace root, or the session's current location when the folder moved underneath the panel; rejects with the path when neither exists |
| `tuiCommand(workspace)` | Resolves the active runtime's TUI command for the addressed session; currently enabled for OpenCode and rejects runtimes without a declared TUI capability |
| `prompt(workspace, text, files?, delivery?)` | Captures and verifies the context around attachment awaits, then calls `session.prompt`; `delivery` forwards `queue`/`steer` for native inbox queuing; IPC failures are normalized to a stable code and message before returning to the renderer |
| `listInbox(workspace)` | Lists the active session's queued user entries via `session.inbox.list` |
| `cancelInbox(workspace, inboxID)` | Cancels a queued inbox entry via `session.inbox.cancel` |
| `steerInbox(workspace, inboxID)` | Delivers a queued entry immediately via `session.inbox.steer` |
| `listForms(workspace)` | Lists pending agent forms for the active session via `form.list` |
| `stageRevert(workspace, messageID, files)` | Stages a revert of the active session back to a message via `session.revert.stage`; `files` restores file snapshots; returns `{messageID, partID?, snapshot?}` |
| `commitRevert(workspace)` | Applies the staged revert via `session.revert.commit` |
| `clearRevert(workspace)` | Discards the staged revert via `session.revert.clear` |
| `replyForm(workspace, formID, answers)` | Submits field answers via `form.reply` |
| `cancelForm(workspace, formID)` | Cancels a pending form via `form.cancel` |
| `startProviderOAuth(workspace, integrationID, methodID)` | Starts an OAuth attempt via `integration.oauth.connect` and returns attempt URL/mode |
| `pollProviderOAuth(workspace, integrationID, attemptID)` | Reads attempt status via `integration.oauth.status` |
| `completeProviderOAuth(workspace, integrationID, attemptID, code?)` | Finishes an attempt via `integration.oauth.complete`, optionally with a pasted code |
| `cancelProviderOAuth(workspace, integrationID, attemptID)` | Aborts an attempt via `integration.oauth.cancel` |
| `listMcpServers(workspace)` | Lists configured MCP servers and their connection status via `mcp.list` |
| `listPlugins(workspace)` | Lists active plugins and their source via `plugin.list` |
| `listSkills(workspace)` | Lists workspace skills via `skill.list` |
| `listCommands(workspace)` | Built-ins (`/compact` + `/compress` alias) + `command.list({location})` + `skill.list({location})` → `CommandOption[]` (`kind: "command" | "skill"`) for the session directory |
| `runCommand(workspace, name, args?)` | Routes built-ins (`/compact`/`/compress` → `session.compact`), otherwise captures and verifies the context around skill lookup and command mutation |
| `searchFiles(workspace, query)` | `file.find({location, query, type: "file"})` → `ReferenceOption[]`; `rel` is the path relative to the session directory, `path` is absolute for prompt attachment |
| `interrupt(workspace)` | Interrupts the captured session and rejects stale completion |
| `replyPermission(workspace, requestID, reply, sessionID)` | Replies only when the supplied session is the captured context session |
| `listPermissions(workspace)` | `permission.request.list()` → `PendingPermissionRequest[]` (`id`, `sessionID`, `action`, `resources`) for every pending request on the service |
| `listDir(workspace, rel)` | Validates the context and confinement, then reads the directory directly from the filesystem (`fs.readdir`) with trailing slashes stripped |
| `revealInFileManager(workspace, rel)` | Validates the context, confinement, and current file or folder, then asks the operating system's native file manager to reveal it |
| `readFile(workspace, rel)` | Confined workspace-relative API read; `null` if unreadable |
| `writeFile(workspace, rel, content, write)` | Confined bounded Node `fs` write; holds and validates the expected disk version, installs by no-replace link, preserves recovery files on concurrent recreation, and emits an identified `file-update` |
| `createFile(workspace, rel)` | Confined `mkdir -p` parents and empty exclusive write; emits `file-update` |
| `createDir(workspace, rel)` | Confined `mkdir` (fails if exists); renderer re-lists after the call |
| `deletePath(workspace, rel)` | Confined `shell.trashItem`; emits tracked deletion only after success and preserves Trash failures for the renderer |
| `detachPath(workspace, rel)` | Confined move to the user-level detached store; removes the entry from the workspace without deleting its contents |
| `renamePath(workspace, rel, newName)` | Confined same-folder no-replace file rename; rejects occupied destinations and directory renames where portable no-replace semantics are unavailable |
| `movePath(workspace, rel, newParent)` | Confined cross-folder move for files and directories via one atomic `fs.rename` (no recovery hold — see architecture); rejects self/descendant, missing, occupied, cross-filesystem, and `.openshell-recovery` source/destination paths; emits a tracked deletion at the source and, for files, an addition at the target |
| `listRecovery(workspace)` | Lists validated durable recovery artifacts under the addressed workspace's `.openshell-recovery` directory |
| `openRecovery(workspace, id)` | Opens the validated artifact selected by opaque recovery record id; never accepts a renderer path |
| `acknowledgeRecovery(workspace, id)` | Persists acknowledgment in the transaction manifest without deleting artifact bytes |
| `listProjects()` | `project.list`, maps to `{directory, name}` |
| `listModels(workspace)` | `model.list` (location = session dir), filters `enabled`, maps to `{id, providerID, name, variants, limit?}` (`limit.context` = the model's context-window size) |
| `listProviderIntegrations(workspace)` | `integration.list` (location = session dir), maps runtime-supported key forms, OAuth labels, environment names, and secret-free credential labels into `ProviderIntegration[]` |
| `connectProviderKey(workspace, integrationID, key, label, answers)` | Sends one bounded write-only key plus provider-specific form answers to `integration.connect.key`; no secret is returned or logged |
| `removeProviderCredential(workspace, credentialID)` | Removes an opaque runtime credential through `credential.remove`; environment connections remain externally managed |
| `modelDefault(workspace)` | `model.default`, maps the same |
| `switchModel(workspace, id, providerID, variant?)` | Switches only the captured context session, then persists the selection |
| `listAgents(workspace)` | `agent.list` (location = session dir), maps to `{id, name}` |
| `switchAgent(workspace, id)` | Switches only the captured context session, then persists the choice |
| `getState()` | The primary (most recently activated) session `{id, directory, workspace}` or null |
| `sessionSelection(workspace)` | `session.get` → `{model?, agent?}` so the UI can restore the addressed session's current picks |
| `providerUsage()` | Delegates to `src/main/provider-usage.ts` → `ProviderUsageResult[]` for every provider (OAuth or API-key) opencode has stored credentials for |
| `runtimeManifests()` | Probes installed runtimes and returns protocol-versioned, secret-free capability manifests for OpenCode and DeepSeek Harness |

Provider usage (`providerUsage()`): the opencode service exposes no
provider plan/rate-limit API yet, so Orbit reads the credentials
opencode persists — OAuth entries from `~/.local/share/opencode/auth.json`
(plus the desktop-app location) and JSON-encoded credentials from the
`account` / `credential` tables of `opencode.db` (V2 rows carry
`active = NULL`; OAuth and API-key values use typed JSON credentials) — and
calls each provider's usage endpoint directly — ChatGPT's
`/backend-api/wham/usage` (5-hour/weekly windows, spend control, plan
type), Anthropic's `/api/oauth/usage` (5h + weekly utilization), GitHub
Copilot's `copilot_internal/user` (credits/quota), OpenCode Go's
`https://opencode.ai/zen/go/v1/usage` (rolling, weekly, and monthly
utilization), and Command Code's `api.commandcode.ai` `/alpha/whoami` +
`/alpha/billing/credits` (5h and weekly rate-limit windows plus
monthly/purchased/free credit balances; org accounts resolve their
`org.id` before querying credits). Command Code also falls back to the
`COMMAND_CODE_API_KEY` environment variable when no auth-store credential
exists, so config-file providers (`apiKey: "{env:COMMAND_CODE_API_KEY}"`)
work without an auth login. Tokens never leave the main process; the
renderer only receives normalized provider snapshots. Each refresh prefers a
new live response and falls back per provider to a plugin snapshot younger
than 15 minutes only when live credentials or the provider endpoint are unavailable.
A provider whose credentials fail authentication and which has no snapshot
is omitted from the result (no subscription to show); retryable network
failures stay visible so a transient outage cannot silently hide an active sub.

Internals:

- `runEventLoop()` — one global reconnecting SSE loop driven by the
  `createStreamPipeline` transport in `src/main/stream-pipeline.ts`: 33ms
  per-directory batched flushing with delta coalescing and snapshot barriers,
  a 30s heartbeat that aborts silent streams without raising a user-facing error, and exponential reconnect
  backoff (250ms base, ×2, 5s cap). Stream errors drop the client so the next
  attempt rediscovers the service, and reconnects emit a synthetic
  `server.connected` so the renderer re-materializes open sessions.
  `deliverEvents` forwards each event as `{kind:"event", type, data}` and
  runs `handleServerEvent` (see `docs/events.md`); handler failures are emitted
  as session-scoped or global structured errors. Stop/restart serializes
  subscription lifetimes, and filesystem side handling requires a matching
  top-level event location.
- `activateSession(info)` — canonicalizes, mints a fresh
  `{id, generation}` workspace identity, and creates a per-session context
  with its own watcher maps and activation guard; re-activating the same
  session id on the same directory returns the existing context unchanged.
  Commits, starts the context watcher, and emits `{kind:"session"}` plus the
  context's recovery records.
- `replayTranscript(messages)` — converts `message.list` output to
  `TranscriptItem[]`: user, internal selection, synthetic/system/skill/shell,
  assistant, and compaction messages in persisted order. Internal selection
  and system prompt entries are retained for state reconstruction but filtered
  from the visible chat. Tool status comes
  from streaming/running/completed/error; parsed input, text/file content,
  metadata, provider state, duration, retry, error, and completion are restored.
- `loadSessionMessages(sessionID)` — `message.list` with one retry; follows
  `cursor.next` pages (first page `order: "asc"`, later pages cursor-only, capped
  at 200) so conversations longer than the server's default page size load
  completely. A persistent failure throws so reopen surfaces an error instead of
  materializing an empty conversation (which would block later rehydration).
- Session retention (`scheduleRetentionPrune` / `pruneExpiredSessions`) — after
  every successful connect (throttled to once per 24h), pages through all
  sessions and permanently deletes those whose last activity is older than 30
  days (`SESSION_RETENTION_MS` in `@shared/retention`). Conversation-less
  sessions (no title and zero token usage — e.g. workspaces opened but never
  prompted) are deleted after only 24 hours (`EMPTY_SESSION_RETENTION_MS`) so
  auto-created empties never accumulate. Sessions currently open in Orbit
  and sessions with unknown timestamps are never deleted; per-session removal
  failures are skipped. `listSessions` applies the same 30-day window and
  additionally hides never-prompted sessions, so they cannot crowd real history
  out of recents.
- `snapshotInputs(context, input)` — recursively walks the tool-call input for
  `filePath`/`file_path`/`path` keys and snapshots those files
  (skips http URLs, dedupes) into the addressed context.
- `gitShow(rel)` — `git show HEAD:<rel>` with a 10s timeout, 16 MiB
  buffer; null on any failure.
- `startWatcher(context)` / `scheduleWatch(context, abs)` /
  `onFsChanged(context, ...)` — one recursive `fs.watch` and 200ms debounced
  pipeline per open context. Every callback captures its
  root/session/generation/maps and checks `currentWatch` after awaits and
  before map mutation or emission.
- `emitFileUpdate(context, ...)` — emits identity-bound `{kind:"file-update"}`.
- `relKey(abs)` — absolute → `/`-separated path relative to the session
  dir; `abs(rel)` the inverse. `shouldSkip` filters `SKIP_DIRS` roots.
- Recovery transactions live under `.openshell-recovery/<timestamp>-<uuid>`.
  Atomically replaced, fsynced manifests record save/rename phase and
  acknowledgment state. Activation reconciles only `source-held` and
  `held-validated` interrupted transactions, where Orbit is known to have
  removed the canonical pathname, and hard-links the held original only when
  that pathname remains missing. Completed, failed, and acknowledged history
  never replays. After reconciliation, a best-effort retention purge removes
  settled transactions (`complete`, `failed`, acknowledged) older than 24h and
  interrupted ones (`source-held`, `held-validated`) older than 7 days; fresh
  transactions are never purged. The recovery root, transaction paths,
  canonical parents, and artifacts reject symlinks and malformed
  ids/manifests; artifact Open actions resolve validated ids rather than
  renderer paths.

## IPC surface (`src/main/index.ts`)

| Channel | Args → Returns |
|---|---|
| `shell:select-folder` | `(generation, runtimeID?) → SessionInfo \| null` (generation accepted before native dialog); the returned session is mounted by the caller — replacing the displayed panels, added as a new panel, or swapped into an existing panel — depending on the store action that opened the dialog |
| `shell:select-directory` | `() → string \| null` — returns the canonical folder chosen in a native dialog without opening a runtime context; workspace bookmarks are renderer-owned and this channel never mutates the selected folder |
| `shell:open-session` | `(dir, generation, runtimeID?) → SessionInfo` — creates a session for `dir` with OpenCode by default or the selected runtime; used for the app-wide replacement view, model-mode additions, and per-panel workspace swaps |
| `shell:select-file` | `(generation, runtimeID?) → OpenFileWorkspaceResult \| null` (generation accepted before native `openFile` dialog); opens the folder containing the chosen file as a single-file workspace through the selected runtime |
| `shell:open-file` | `(file, generation, runtimeID?) → OpenFileWorkspaceResult` — programmatic single-file workspace open for an absolute path (parent-folder runtime session + the file to open) |
| `shell:open-external` | `(workspace, file) → ExternalOpenResult` — resolves a dropped absolute path: in-repo files become `{kind:"relative", rel, content}`, outside-repo files a writable `{kind:"standalone", path, content}` |
| `shell:stat-external` | `(file) → ExternalKind` — probes an absolute path as `file` / `directory` / `missing` to route mixed file/folder drops |
| `shell:fs-write-standalone` | `(file, content, expectedContent, overwrite) → void` — atomic standalone-file write for external tabs |
| `shell:fs-import` | `(workspace, destDir, sources) → ImportResult[]` — copies external files/folders into the workspace at `destDir` (empty `destDir` is the workspace root) |
| `shell:sessions` | `() → SessionSummary[]` |
| `shell:runtimes` | `() → RuntimeManifest[]` — installed status, native version, normalized protocol version, and capability bitmap |
| `shell:active-sessions` | `() → SessionInfo[]` — open backend sessions, most recently activated last |
| `shell:close-session` | `(workspace) → void` — tears down the backend context when a panel closes; the opencode session remains reopenable |
| `shell:open-session-id` | `(sessionID, generation, runtimeID?) → ReopenedSession`; persisted runtime identity resolves omitted ids; a differing `runtimeID` with no active context remaps the session to the requested runtime on the same directory |
| `shell:delete-session` | `(sessionID) → void` — permanently destroys the opencode session server-side; the panel closes first and DeepSeek sessions are rejected |
| `shell:session-transcript` | `(sessionID) → { transcript, todos }` — stream materialization snapshot; does not activate a context |
| `shell:session-usage` | `(sessionID) → SessionUsage \| null` — normalized `cost`/`tokens` for the addressed session; materialization and compaction refresh the live usage popup |
| `shell:prompt` | `(workspace, text, files?, delivery?) → SessionTranscript` |
| `shell:inbox-list` | `(workspace) → SessionInboxEntry[]` |
| `shell:inbox-cancel` | `(workspace, inboxID) → void` |
| `shell:inbox-steer` | `(workspace, inboxID) → void` |
| `shell:forms-list` | `(workspace) → PendingFormRequest[]` |
| `shell:form-reply` | `(workspace, formID, answers) → void` |
| `shell:form-cancel` | `(workspace, formID) → void` |
| `shell:provider-oauth-start` | `(workspace, integrationID, methodID) → ProviderOAuthAttempt` |
| `shell:provider-oauth-poll` | `(workspace, integrationID, attemptID) → ProviderOAuthPoll` |
| `shell:provider-oauth-complete` | `(workspace, integrationID, attemptID, code?) → void` |
| `shell:provider-oauth-cancel` | `(workspace, integrationID, attemptID) → void` |
| `shell:mcp-list` | `(workspace) → McpServerOption[]` |
| `shell:plugins-list` | `(workspace) → PluginOption[]` |
| `shell:skills-list` | `(workspace) → SkillOption[]` |
| `shell:commands` | `(workspace) → CommandOption[]` (built-ins like `/compact` + opencode slash commands + skills for the session directory) |
| `shell:run-command` | `(workspace, name, args?) → void` |
| `shell:find-files` | `(workspace, query) → ReferenceOption[]` (`file.find` search for @-mentions; `rel` paths relative to the session directory) |
| `shell:select-files` | `() → string[]` (native multi-file dialog) |
| `shell:select-images` | `() → string[]` (native multi-file dialog filtered to image types) |
| `shell:read-image-preview` | `(absolutePath) → string \| null` — resized data-URL thumbnail for composer attachment chips; `null` when the file is not a decodable image |
| `shell:interrupt` | `(workspace) → void` |
| `shell:fs-list` | `(workspace, rel) → TreeEntry[]` |
| `shell:fs-reveal` | `(workspace, rel) → void` — validates and reveals a file or folder in the operating system's native file manager |
| `shell:fs-read` | `(workspace, rel) → string \| null` |
| `shell:fs-write` | `(workspace, rel, content, write) → void` |
| `shell:fs-create-file` | `(workspace, rel) → void` |
| `shell:fs-create-dir` | `(workspace, rel) → void` |
| `shell:fs-delete` | `(workspace, rel) → void` |
| `shell:fs-detach` | `(workspace, rel) → void` |
| `shell:fs-rename` | `(workspace, rel, newName) → void` |
| `shell:fs-move` | `(workspace, rel, newParent) → void`; `newParent` empty means the workspace root |
| `shell:recovery-list` | `(workspace) → RecoveryRecord[]` |
| `shell:recovery-open` | `(workspace, recoveryID) → void` |
| `shell:recovery-acknowledge` | `(workspace, recoveryID) → void`; metadata only, never deletes bytes |
| `shell:projects` | `() → ProjectInfo[]` |
| `shell:models` | `(workspace) → ModelOption[]` |
| `shell:model-default` | `(workspace) → ModelOption \| null` |
| `shell:switch-model` | `(workspace, id, providerID, variant?) → void` |
| `shell:agents` | `(workspace) → AgentOption[]` |
| `shell:switch-agent` | `(workspace, id) → void` |
| `shell:terminal-start` | `(workspace, id, directory?) → resolved cwd`; renderer allocates a validated UUID id before invoking, main confines the optional relative directory to the addressed workspace and uses it as cwd |
| `shell:agent-tui-start` | `(workspace, id) → void`; starts the addressed runtime's TUI command in the workspace's canonical cwd |
| `shell:terminal-input` | `(workspace, id, data) → void` |
| `shell:terminal-resize` | `(workspace, id, cols, rows) → void` |
| `shell:terminal-stop` | `(workspace, id) → void` |
| `shell:permission-reply` | `(workspace, requestID, reply, sessionID) → void` |
| `shell:list-permissions` | `(workspace) → PendingPermissionRequest[]`; pending permission requests across the service's sessions |
| `shell:state` | `() → SessionInfo \| null` |
| `shell:session-selection` | `(workspace) → SessionSelection \| null` |
| `shell:session-revert-stage` | `(workspace, messageID, files) → SessionRevertStage` — stages a revert of the active session to a message, optionally restoring file snapshots |
| `shell:session-revert-commit` | `(workspace) → void` — applies the staged revert |
| `shell:session-revert-clear` | `(workspace) → void` — discards the staged revert |
| `shell:provider-usage` | `() → ProviderUsageResult[]` |
| `shell:provider-integrations` | `(workspace) → ProviderIntegration[]` — runtime-supported provider catalog and secret-free connection metadata |
| `shell:provider-key-connect` | `(workspace, integrationID, key, label, answers) → void` — validates and forwards a write-only provider key and bounded form answers |
| `shell:provider-credential-remove` | `(workspace, credentialID) → void` — removes a stored credential by opaque id |
| `shell:health` | `() → boolean` |
| `shell:window-view` | `(view: "landing" \| "session") → void` — switches the window between the fixed landing size and the persisted session size (see Window sizing) |
| `shell:install-app` | `() → {ok, message}`; macOS only — spawns `scripts/install-app.mjs` to build and package the app, then replaces `/Applications/Orbit.app` |
| `shell:validate-w3c` | `(path, content) → W3cDiagnostic[]`; calls the Nu Html Checker or W3C CSS Validator for HTML and plain CSS paths; preprocessor stylesheets (SCSS, LESS, Sass) return no diagnostics |
| `shell:vite-start` | `(workspace) → VitePreview` — starts a workspace-rooted Vite dev server on loopback (reuses the running one) and opens its URL in the default browser |
| `shell:vite-stop` | `(workspace) → void` — stops the workspace's Vite dev server when one is running |
| `shell:take-pending-paths` | `() → string[]` — drains OS-dropped or launch paths queued before the renderer was ready |

Outbound: `webContents.send("shell:message", msg)` for every backend
message. Every `shell:*` invoke is accepted only from the active window's
owned main frame while that frame is at the trusted application location;
other WebContents, subframes, null frames, and unexpected URLs are rejected
before the handler runs. External links from Markdown, tool attachments, and
popup attempts share one policy: only absolute, credential-free `https:` URLs
reach `shell.openExternal`; malformed URLs, `http:`, `file:`, custom schemes,
and URLs containing credentials are inert. The popup itself is always denied.
The packaged app always loads the exact bundled `file:` document and ignores
`ELECTRON_RENDERER_URL`. An unpackaged app may use only a credential-free
loopback `http:` development URL and then trusts that exact origin. Other main-frame navigations and
redirects are canceled. The window is `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, macOS
`titleBarStyle: "hiddenInset"`.

### Window sizing (`src/main/window-sizing.ts`)

The window has two size profiles driven by the renderer through
`shell:window-view`. The **landing** view (no open session) always snaps to the
fixed `LANDING_WIDTH × LANDING_HEIGHT` (760×522). The **session** view applies
the last session size the user resized to, persisted as
`{ version: 2, session: { width, height } }` in `window-bounds.json` under
userData; a legacy flat `{ width, height }` file migrates into that profile.
Resizes are saved (400ms debounce) only while the current view is `"session"`,
and never while minimized, maximized, or full screen, so landing resizes never
clobber the session profile. With nothing saved yet the session view falls back
to `DEFAULT_SESSION_SIZE` (1280×800). View switches resize and then center the
window on the current display (skipped while maximized or full screen), so a
landing → session grow keeps the saved session size centered instead of
extending down-right from the landing corner. The app boots centered at the landing size; the
renderer flips the view when the first panel opens and when the last one closes.

The app icon (`resources/icon.svg` →
rasterized via `npm run generate-icons` into
`resources/icon.png` + `resources/icon.icns`, the paper-and-clay
open-lid terminal mark with transparent rounded-rect margins) is set as the BrowserWindow `icon` on
Windows/Linux and via `app.dock.setIcon` on macOS; the window flash
background is the warm `#161410`. On macOS, `npm run dev` and `npm start`
use `scripts/launch.mjs` to run
`scripts/make-dev-app.mjs`, which copies
`node_modules/electron/dist/Electron.app` to `dev/Orbit.app`
(gitignored), patches its Info.plist (name "Orbit", icon.icns,
`dev.openshell.app` id) and ad-hoc re-signs it. The launcher then
points electron-vite at that bundle via `ELECTRON_EXEC_PATH` so the dock
shows the real name and icon instead of Electron's defaults. Linux and Windows
skip bundle preparation and use plain Electron. Production packaging uses the
same brand: `npm run pack` (or `npm run install-app`, which also installs into
`/Applications`) runs `scripts/install-app.mjs`, which
builds `out/`, packages `release/mac/Orbit.app` with electron-builder
(`electron-builder.yml`; `asar: false` keeps the unpacked `app/` layout so
the trusted packaged document stays exactly
`file://…/Orbit.app/Contents/Resources/app/out/renderer/index.html`),
ad-hoc re-signs the bundle, and — for the install flow — replaces
`/Applications/Orbit.app` with `cp -R`, preserving the signature. The
packaged payload is then swapped for the live launcher
(`scripts/live-launcher.cjs` plus a minimal `package.json` and a gitignored
`.orbit-repo.json` recording the repository path and Node binary), so the
installed
app keeps its Electron runtime and icon but always runs the repository's
latest build, silently auto-rebuilding first when sources are newer than
`out/`, falling back to the last known good build if that rebuild fails.
`shell:install-app` runs the script as a child of the Electron binary under
`ELECTRON_RUN_AS_NODE=1` and parses the JSON result line it prints. The
renderer gates the button on `window.openshell.isPackaged`: main passes
`--openshell-packaged` as an `additionalArguments` flag when
`app.isPackaged`, and the preload exposes it from `process.argv`.

PTY messages come from a second emitter, `TerminalManager`
(`src/main/terminal.ts`): it forwards `{kind:"terminal-data",
terminal:{id,data}}` and `{kind:"terminal-exit", terminal:{id,exitCode}}`
over the same `shell:message` channel. Every PTY is owned by the workspace
identity that created it, and each session panel's terminal tray boots and
stops its own terminals as the user switches focus — `stopAll()` only runs
at quit, where it kills each child, waits (bounded, 3s per terminal) for the
exit events to drain, then detaches the callbacks so no pty callback can
fire into Node teardown and abort the process. The `before-quit` handler
bounds the whole shutdown at 10s and always proceeds to `app.quit()`. `before-input-event` intercepts
⌘W / Ctrl+W (so it never closes the window) and forwards
`{kind:"ui-command", command:"toggle-word-wrap"}` to the renderer instead
(the user's muscle memory maps ⌘W to word wrap, and the window must never
die on it). DevTools follow the browser conventions: F12 toggles a
bottom-docked inspector (never detached) and ⌘⇧C (Ctrl+Shift+C) toggles
element-picking mode. Hover highlighting runs over the Chrome DevTools
Protocol (`webContents.debugger`, `Overlay.setInspectMode` with
`mode: "searchForNode"`); the pick itself is routed through
`inspectElement` at the picked node's box-model center
(`DOM.getBoxModel`) — overlay events only reach our debugger session,
and the Elements panel only selects nodes on browser-side inspects.
Esc, picking an element, ⌘⇧C, or closing DevTools exits the mode.
Keyboard handling is split: the app webContents uses
`before-input-event` (F12 toggle, Esc, ⌘⇧C); the DevTools webContents
cannot use it (Electron's `InspectableWebContents` delegate never
implements `PreHandleKeyboardEvent`), so a keydown watcher is injected
into the frontend page with `executeJavaScript` and polled from main —
F12 closes DevTools, Esc stops the picker, whichever side has focus.
The same watcher intercepts clicks on CSS rule source links (the
`styles.css:12` links in the Styles panel): it prevents the frontend's
own reveal, detects the clicked link by its source URL attributes
(including `title="<url>:<line>"`), and re-sends it as a `ui-command`
`open-source` with `{ path, line }` so the editor opens the file
at the clicked rule — DevTools edits are ephemeral, the editor's are not.
(The injected regexes are embedded in a template literal, so every
backslash is doubled to survive string-escape cooking.) Path resolution
strips the `:line` suffix and accepts `file://` and dev-server
`http(s)://` URLs (mapping the URL path onto the application directory or
using a contained absolute pathname verbatim, e.g. Vite's absolute served paths),
falling back to a basename search that skips `node_modules`, `out`,
`dist`, etc. — both the direct and the searched resolution skip known
build-output directories so a hashed bundle is never opened as if it
were source. DevTools always inspects Orbit's own renderer, so resolution
is confined to the canonical application directory and never searches the
active user workspace. The command carries the canonical absolute path; the
renderer opens it through the external-file workflow as a writable standalone
tab without replacing the active session. In dev mode (where Vite serves the real `.scss` sources and
`css.devSourcemap` is on) the links in the Styles panel are the actual
source files with accurate line numbers, so clicking one opens the
editable stylesheet. In the compiled app the links point at the hashed
bundle and Vite's build emits no CSS maps (a Vite 6 limitation), so
bundle links do not open an editable app-source tab.

Workspace paths are strict `/`-separated relative paths: absolute paths,
empty file paths, traversal, backslashes, NULs, duplicate separators, and
oversized values are rejected. Main canonicalizes the root and rejects any
existing symlink component, including intermediate symlink parents for new
targets. This stable-topology policy means Explorer capabilities do not follow
symlinks, but Node pathname APIs cannot eliminate an external symlink swap
between validation and use. File content and every `expectedContent` value are
capped at 8 MiB, including explicit overwrites. DevTools source resolution
canonicalizes the application root and rejects source candidates and symlinks
outside it before the renderer uses the external-file capability. Terminal ids use `term-N`, input
is capped at 1 MiB per invoke, dimensions are positive integers bounded to
1000 columns by 500 rows, unknown PTYs fail, and every PTY is owned by the
workspace identity that created it.
Each picker activation grants exactly one `inspectNodeRequested` claim, so
Chromium's duplicate pointer/mouse events cannot start competing selections.
Main awaits `mode: "none"` before calling `inspectElement`, and the picker
lifecycle is token-guarded between asynchronous setup commands so a canceled
activation cannot re-arm or wedge the state. Auto-repeat ⌘⇧C events are ignored.
Chromium's `inspectModeCanceled` event only clears local state and never echoes
another `mode: "none"` command back into the protocol.
Gotcha: `highlightConfig` is a required
parameter even for `mode: "none"`; omitting it makes Chromium reject
the command and leaves the overlay stuck in search mode, flashing
highlights forever.

Startup (`app.whenReady`): `start()` → register backend and terminal forwarders
→ register IPC → `createWindow()` → begin asynchronous `connect()`. On
`window-all-closed` the app quits on every platform and the backend is
stopped in `before-quit`; the window is created hidden and shown on
`ready-to-show` (5s fallback), renderer console output is forwarded to
main stdout, and a renderer crash logs and reloads (once per 10s) instead
of leaving a dead black window. On macOS activate: re-creates only the
window if it was destroyed; the backend's single-flight event loop remains
active while the window lives. Opening a new session no longer resets the
terminal tray: terminals belong to their workspace identity and each
session's tray manages its own PTYs.
