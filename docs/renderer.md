# Module: renderer

> **Document role:** canonical owner for renderer state ownership, renderer-side invariants, major actions, and component responsibilities. Keep presentation minutiae in source/tests unless they encode a non-obvious invariant.

`src/renderer/src/` — React 19 app. All state lives in one store
(`store.tsx`); components are presentational consumers of it. Monaco is
configured in `monaco.ts`.

## Store (`store.tsx`)

Exposed via `useStore()` (context). State:

| Slice | Shape | Notes |
|---|---|---|
| `session` | `SessionInfo \| null` | the focused session (derived from `panels` + `activeSessionID`); null → Welcome screen on first launch, otherwise an empty IDE whose explorer offers an open-workspace CTA |
| `panels` | `SessionInfo[]` | all attached/live sessions in panel order; each panel continues streaming even when normal coding mode renders only the focused coding session |
| `activeSessions` | `SessionInfo[]` | backend-owned open contexts, reconciled every second independently of visible panels; drives the complete **Open now** inventory |
| `savedWorkspaces` | `ProjectInfo[]` | Orbit-owned workspace bookmarks persisted in `localStorage` ("orbit.savedWorkspaces"); the Welcome screen can add one directly, and user-initiated opens, attachments, and swaps bookmark their workspace automatically; removing one changes only this list and never touches the filesystem |
| `panelViews` | `Record<workspaceID, PanelView>` | per-panel scoped projection (`session`, `busy`, `transcript`, `todos`, `sessionUsage`, `models`, `currentModel`, `agents`, `currentAgent`) consumed through `usePanel(workspace)` |
| `activeSessionID` | `string \| null` | focused session id; the editor, sidebar, tree, and terminal tray bind to the focused panel while every panel keeps streaming |
| `connected` | `boolean` | from `health()` on mount |
| `busy` | `boolean` | active-session projection of the per-session busy map |
| `todos` | `TodoItem[]` | structured OpenCode todo state shown as persistent agent steps in the prompt dock |
| `transcript` | `TranscriptItem[]` | active-session projection of the per-session transcript map |
| `sessionUsage` | `SessionUsage \| null` | active-session projection of cumulative token usage/cost; hydrated from `session.get` whenever a panel is attached (reopen, add control, workspace swap, folder pick, startup restore) and kept fresh by `session.usage.updated` / `session.usage.recorded`; `session.compaction.ended` and manual `/compact` re-poll it (immediately plus a delayed backstop against slow backends) and snapshot the pre-compaction input total as the compaction baseline, so the context-window fill drops instead of sticking at its pre-compaction value; shown in the agent header popup |
| `providerUsage` | `ProviderUsageResult[]` | live-first per-provider plan/rate-limit snapshots fetched via `refreshProviderUsage()`; rendered under the session usage popup as remaining quota (`% left`) while warning tones derive from consumed quota |
| `providerUsageLoading` | `boolean` | true while `refreshProviderUsage()` is in flight (refetch happens each time the usage popup opens) |
| `tabs` | `Tab[]` | open editor tabs for the focused workspace (per-workspace record; each session restores its own tabs on focus) |
| `activePath` | `string \| null` | active tab path for the focused workspace |
| `singleFile` | `string \| null` | the active workspace's single-file path (set when a file was opened as the workspace via `selectFile`/`openFileWorkspace`); non-null makes the sidebar render true single-file mode (file name, one file row, no folder tree) |
| `agentFiles` | `Map<path, AgentFileState>` | `{baseline, content, deleted}` for observed files still differing from their effective baseline; drives Changes and known/unknown diff state; per workspace |
| `tree` | `Record<relPath, TreeEntry[]>` | lazy-loaded explorer cache; per workspace |
| `expanded` | `Set<relPath>` | open tree directories; per workspace |
| `toasts` | `Toast[]` | transient notifications |
| `recoveryRecords` | `RecoveryRecord[]` | durable workspace artifacts for the focused workspace; unacknowledged records remain actionable across restart |
| `models` | `ModelOption[]` | for the composer model/strength picker |
| `availableModels` / `lastModel` | `ModelOption[]` / `ModelOption \| null` | last loaded model catalog and selection retained for the empty agent panel after its workspace closes; controls remain inert until a workspace is active |
| `currentModel` | `ModelOption \| null` | per workspace; seeded from the session selection (falling back to `modelDefault()`) when a panel activates so a new session never displays another session's model; live-updated by `session.model.selected` for the addressed session; includes selected `variant`; carries `limit.context` from the model catalog, which the usage popup uses to compute context-window fill |
| `agents` | `AgentOption[]` | for the composer agent picker |
| `currentAgent` | `AgentOption \| null` | per workspace; seeded from the session selection, falling back to the session's creation agent and then `build`; live-updated by `session.agent.selected` for the addressed session and optimistic `switchAgent` |
| `runtimes` | `RuntimeManifest[]` | runtime availability and capability manifests; `AgentPanel` uses the active manifest's `tui` flag to enable the embedded TUI option |
| `approvalMode` | `ApprovalMode` | `ask` shows permission cards; `approve` automatically replies `once` |
| `wordWrap` | `boolean` | Monaco `wordWrap` setting, persisted to `localStorage` ("wordWrap") |
| `sessions` | `SessionSummary[]` | recent sessions for the Welcome screen and the sidebar's Sessions pane |
| `ctxMenu` | `{x, y, target} \| null` | explorer right-click menu position and target entry (`null` = empty area) |
| `pendingCreate` | `{parent, kind} \| null` | inline "new file/folder" name input target |
| `pendingRename` | `{path} \| null` | inline rename input target |

## Authoritative chat store (`chat-store.ts`)

Model-response events (`session.step.*`, `session.text.*`,
`session.reasoning.*`, `session.tool.*`, `session.retry.scheduled`,
`message.*`, plus execution/status lifecycle events) mutate a per-session
authoritative store — server messages and parts kept in binary-search ordered
maps (`binary.ts`) plus a session status map — instead of appending to the
transcript directly. The transcript the UI reads is a projection
(`projectAssistantItems`) applied after each event batch; auxiliary items
(permissions, shells, selections, compaction) still reduce into the flat
transcript via `reduceChatStream` in `chat-stream.ts`. Full part snapshots
carry dedupe bookkeeping so a trailing delta already included in a snapshot
is not applied twice (exact suffix match only — deltas are otherwise
concatenated verbatim like OpenCode's own reducer), finished tool cards
cannot regress, and history hydration (`hydrateChatState`) never shrinks
longer live text. Parts render in arrival order: each insert stamps a `seq`
counter, projection sorts by it, and the timeline groups consecutive
activity entries while keeping interleaved prose between them. Text and
reasoning segments without an explicit `ordinal` resolve to the newest
same-type part, matching upstream's implicit ordinal.

Prompt submission reconciles the returned canonical snapshot once without
polling, deleting, or rebuilding the live store. Pushed reasoning and text
deltas therefore remain visible between OpenCode steps, while
`session.execution.*` stays authoritative for the composer until the terminal
execution event.

When a delta arrives for an unknown message or part (an incomplete session
snapshot), the store materializes the session over `shell:session-transcript`
and merges the authoritative history. `server.connected` /
`global.disposed` re-materialize every open panel, which covers gaps after
stream reconnects.

## Streaming lifecycle (`streaming.ts`, `session-activity.ts`, `assistant-status.ts`)

Orbit's synchronized streaming stack tracks which
message is streaming per session and its lifecycle phase
(`streaming` / `cooldown` / `completed`) with `startedAt` / `lastUpdateAt` /
`completedAt` timestamps; `lastUpdateAt` writes are throttled to a 1s
heartbeat for lifecycle timestamps; every changed text, reasoning, and tool
event is projected immediately into the visible per-session transcript. The
store reconciles streaming state incrementally after every chat event batch
(`updateChangedStreamingSessions` compares the pre-event snapshot against the
copy-on-write message/status maps), falls back to a full reconcile after
history hydration, and touches the heartbeat for part deltas.
`session-activity.ts` resolves the session phase (`idle` / `busy` / `retry`):
it mirrors the authoritative status, falls back to the trailing incomplete
assistant while status settles, and yields to a pending permission so the
send button stays a send. Three store-side guarantees keep that fallback from
latching. Authoritative end-of-turn signals (`session.idle`, `session.error`,
`session.execution.*`) materialize completion of the trailing assistant in
the chat store even if its completion marker was lost. Terminal message/part
snapshots cannot promote an already-idle session back to busy; prompt
submission inserts the optimistic user message into both the transcript and
authoritative chat store before marking the session busy, so the elapsed clock
starts from the current turn instead of an older prompt. Only events that
represent active work can restore busy after a quiet settle. Terminal message
finishes also clear busy directly, so the composer and turn status do not
depend on a later `session.idle` event. Finally, a 1s settle
watchdog finalizes any panel whose trailing assistant stays incomplete without
stream activity for 60s (or immediately once the runtime reported idle), which
is what flips the composer's stop button back to send after a missed end event
or a reopened session with a dead tail. Live stream content restores busy on a
settled session (unless a stop is in flight), so a watchdog false-positive
self-heals on the next delta.

While a turn is active, `AgentPanel` has one chronological activity surface.
Reasoning, tool calls, command output, progress, and final text update their own
stable inline nodes; there is no mirrored activity footer above the composer.
Before the runtime emits the first concrete item, the timeline shows one minimal
inline working placeholder and replaces it as soon as the real item arrives. A
resize observer follows timeline growth while the reader remains at the floor,
so streamed content stays at the live edge without a second surface changing the
viewport height.
`assistant-status.ts` derives the working summary
every panel exposes: the active model (from the trailing assistant's
`parentID` back to its user message), the active part (text → "composing",
reasoning → "thinking", running tool → its tool phrase, editing tools →
"editing file", otherwise "preparing response"), the fully-synthetic
message guard, the forming state, `canAbort`, unacknowledged abort flags set
by `stop()`, and retry info. Interactive questions use the form dock described
below rather than the status overlay. `PanelView.activity`,
`PanelView.assistantStatus`, `PanelView.forming`, `PanelView.activeModel`,
and `PanelView.streaming` carry these to components; the agent header shows
the live status beside a green working indicator and the composer's stop
button title uses the same status text.

## Message queue (`message-queue.ts`, `messages/`)

Queued follow-ups are native: sending a prompt while the session is working
submits it immediately through `session.prompt` with `delivery` set from
`followUpBehavior` (`queue`, the default, holds it in the server's session
inbox; `steer` delivers it into the running turn without interrupting). The
server owns ordering, delivery, and crash safety, and reports the lifecycle
through `session.inbox.enqueued/delivered/cancelled/delivery.changed`. The
store tracks user-type entries per session (`inboxBySession`), hydrated via
`shell:inbox-list` on attach, and merges them with a small persisted local
queue that only catches submissions that failed outright (max 20 messages,
50 targets; pre-v3 persisted queues migrate into a quarantine map).
`QueuedMessageChips` renders both sources above the composer with first-line
previews, attachment counts, edit-back-to-composer, send-now (native entries
steer, local entries prompt), and remove (native entries cancel server-side);
drag-reordering only exists between adjacent local fallback entries because
server inbox order is FIFO by submission. The former client-side auto-send
loop — idle-transition dispatch, abort window, retry backoff — was retired:
the server performs all of that by holding and delivering inbox entries.

Actions: `openSession` / `selectFolder` (replace the current panels with one fresh
panel and automatically save its directory as a workspace), `saveWorkspace`
(bookmark a directory from the native folder picker), `addModelPanel(dir)`
(explicit model-mode addition to a directory and bookmark it),
`selectAddPanel` (model-mode addition from the native folder picker, so each
new panel can target a different project), `selectFile` / `openFileWorkspace`
(open a single file as a true single-file workspace: replace the panels with a
session on the file's parent folder, mark the sidebar single-file, and open the
file as the active tab), `openExternalPath(abs)` (resolve a dragged/dropped
path against the current session: in-workspace files open normally, outside
files open as editable standalone tabs saved back to their real path),
`importPaths(destDir, sources)` (copy external files/folders into the workspace
at `destDir`, seeding clean baselines so imports never show as changes),
`dropIntoExplorer(paths)` (imports dropped files into the current workspace root
and imports dropped folders there without changing the active panels),
`selectPanelDirectory(workspace)`
(swap one panel to a folder picked in the native dialog) and
`changePanelDirectory(workspace, dir)` (swap one panel to a directory without a
dialog), `reopenSession(id, silent)`
(focus a running panel, otherwise replace the selected panel or the current view when no panel is selected unless silent), `focusSession(id)`,
`closePanel(id)`, `loadSessions`, `sendPrompt(text, files, workspace?)`, `stop(workspace?)`,
`refreshProviderUsage`, `loadModels(workspace?)`, `switchModel(id, providerID, variant?, workspace?)`,
`loadAgents(workspace?)`, `switchAgent(id, workspace?)`, `toggleApprovalMode`, `toggleWordWrap`,
`openFile(path, {mode}, workspace?)`, `closeTab`, `setActive`, `setTabMode`, `editContent`, `saveTab`,
`reloadTab`, `overwriteTab`, `mergeTab`, `toggleDir`, `ensureRootOpen`,
`replyPermission(requestID, reply, sessionID?)`,
`reconcilePermissions` (polls `shell:list-permissions` per open panel workspace on a 3s interval and on
`server.connected`; appends missing pending cards, resolves cards whose requests vanished — e.g. answered
in an attached TUI — while preserving event-backed cards when a list request fails),
`openCtxMenu`, `closeCtxMenu`, `startCreate(parent, kind)`, `startRename(path)`, `cancelPending`,
`commitName(name)`, `deleteEntry(path)`, `moveEntry(path, destDir)`,
`revealInFileManager(path)`,
`openRecovery(id)`, `acknowledgeRecovery(id)`. `closePanel` invokes
`shell:close-session` so main tears down the panel's backend context
(watcher, context map) while the opencode session stays reopenable. Each panel
can point at its own directory: `selectAddPanel` opens the native folder
picker and attaches the chosen session as a new panel, while
`selectPanelDirectory` / `changePanelDirectory` swap an existing panel to a
fresh session on another directory in place — the replaced session is detached
rather than torn down (it keeps its backend context and stays listed in
**Open now** until explicitly closed), the panel keeps its position and focus,
and the old session remains reopenable from recents. The optional workspace/session parameters let
a background panel's composer act on its own session while the focused session's editor keeps
its state; they default to the focused session. `commitName`/`deleteEntry`/
`moveEntry` call the `shell:fs-*` mutation channels, then re-list every expanded
ancestor dir of the touched path so the tree stays current (directories
emit no `file-update`), move/close matching tabs, and move `agentFiles`
entries on rename. `moveEntry` re-lists both the old parent and the
destination and drops `deleted` change entries instead of remapping them,
so a moved folder never reappears in Changes as deleted at its new path.

Filesystem and terminal calls carry the addressed panel's `session.workspace`,
the immutable identity for that activation. Main resolves each identity against
its open context map and rejects unknown or replaced identities. `open-source`
carries a canonical absolute app-source path. With an active session, the
renderer passes it through `openExternalPath`, producing a writable standalone
tab when the app source is outside that workspace without replacing any panels;
when the active workspace is the app repository, it opens as a normal relative
tab. With no active session, the containing directory is opened first.

Sessions activate concurrently when explicitly restored or added in model
mode. Replacing panels detaches the replaced sessions rather than closing
them: each keeps its backend context, chat state, and **Open now** entry until
it is reopened or explicitly closed (the row X), so opening a new session never
drops the previous one from the jump list. Workspace opening
otherwise replaces the displayed panels, while every async
continuation captures its workspace identity and mutates only that workspace's
records, so a slow operation from panel A can never populate panel B's editor
or tree. Focus has a monotonic version: a late activation completion never
steals focus from a newer user action. Startup never reopens sessions from a
previous process: a fresh launch always shows the Welcome screen until the
user opens a folder, file, or recent session, and any stale
`orbit.sessionLayout` record left by an older build is deleted on startup.
Only live backend contexts are re-attached at startup (which covers a
renderer reload while the main process is still running). They reopen
sequentially in backend order through the existing `openSessionById`
validation/canonicalization path, and the last one is focused only if the
user hasn't already acted, so deleted or moved workspaces, unavailable
runtimes, and individual reopen failures are skipped without blocking
launch. Past sessions stay reachable through recents and the **Open now**
inventory. A renderer reload still restores live backend contexts; editor
tabs, changes, terminals,
permissions, queues, prompts, and other transient state are not persisted for
this purpose.
`file-update` is accepted only when both its session ID and full workspace
identity match an open panel. A destination update with `movedFrom` remaps the
open tab, active path, and pending-save ownership before applying the new disk
content. Uncorrelated deletion keeps the tab's last content and deleted/conflict
state so the user can recover or explicitly resolve it.

Key mechanisms:

- **Event dispatch** — the `onMessage` effect handles `session` /
  `file-update` / `event` messages. The event switch is documented in
  `docs/events.md`. Every session event is reduced under its own `sessionID`;
  side effects (model/agent selection, todos, permissions, busy) land on the
  panel that owns the addressed session, so background panels stream
  independently. `{kind:"session"}` messages upsert panels idempotently.
  Current V2 `data` and legacy `properties` envelopes are normalized before
  dispatch. OpenCode's V2 permission names are adapted to the common names.
- **OpenCode stream batching** — events queue for a 33ms frame and adjacent
  text, reasoning, and tool-input deltas are coalesced before React updates.
  Adjacent authoritative snapshots of the same legacy part collapse to the
  latest snapshot. A timer is used instead of animation frames so background
  windows continue draining the stream.
- **Session retention** — completed tool and shell output retains at most 8 KiB,
  split between the beginning and end with the omitted character count in the
  middle. Text tool content is discarded after it is projected into `output`;
  file content blocks remain available. Live reduction and replay hydration use
  the same policy. The active stream plus the four most recently updated
  inactive streams are retained in memory; usage records follow the same LRU
  policy. Open panels are exempt from eviction, so a background panel's
  transcript and usage can never be silently blanked by other sessions'
  streams. A panel whose record was evicted while closed (or is otherwise
  missing) is re-hydrated from OpenCode when it is focused or reopened, so
  closed sessions remain reopenable and are hydrated on demand.
- **Selection parity** — catalog refreshes reconcile against
  `sessionSelection()` before falling back to `modelDefault()`, so a newly
  created or reopened GPT/agent session cannot be mislabeled with the previous
  session's model in the composer.
- **Catalog self-heal** — the store re-checks backend health every 2s until
  the first successful connect; a `connected` effect then re-runs
  `loadModels()` / `loadAgents()` once the backend client is up, so a boot or
  reconnect that first hit a silent empty catalog (no client yet) is retried
  and the composer agent/model menus never stay empty. `agent.updated` and
  `catalog.updated` events additionally refetch the agent/model catalogs when
  the service resolves them lazily after a session opened, and opening a
  picker menu whose list is still empty refetches that catalog and shows a
  "No agents available" placeholder instead of a blank box.
- **V2 session reducer** — `chat-stream.ts` buffers admitted input until its
  promoted event, retains non-chat agent/model switches as internal state, and
  folds synthetic/skill/shell/compaction messages, assistant lifecycle, and
  legacy `message.*` projections into ordered `TranscriptItem`s. Tool
  state retains parsed input, content blocks, metadata, execution state, and
  provider state. Durable end/snapshot events are authoritative; terminal
  tool states cannot regress when events arrive late.
- **Revision-safe persistence** — `EditorPersistence` receives immutable
  workspace/path/content/revision snapshots, debounces 900ms, serializes each
  workspace/file, and strongly identifies echoes. Dirty clears only for the
  matching current revision; ⌘S cancels the timer and saves that revision.
- **Lifecycle and conflicts** — reset, close, delete, rename, switch, and
  unmount invalidate relevant timers, expected echoes, and completions.
  External updates advance a per-path conflict generation, so completion of a
  write already in flight cannot clear the newer conflict.
  External updates preserve edits and pause saving until explicit Reload,
  Overwrite, or Keep editing to merge followed by Save merged content.
- **Diff wiring** — tabs carry the first established known/unknown `baseline`
  from `agentFiles`; saves do not replace it. Known content enables Diff,
  unknown content stays labeled as observed with Diff unavailable, and
  `stale`/`deleted` flags surface external changes.

- **V2 transcript replay** — reopened sessions accept OpenCode's flat
  `SessionMessageInfo[]` plus legacy `info`/`parts` projections and reconstruct
  the same user, selection, synthetic/system/skill/shell, assistant, and
  compaction items used by the live reducer. Selection and system prompt items
  remain available for state reconstruction but are filtered from the chat
  timeline. Synthetic `<system-reminder>` entries are also retained for
  replay but filtered from the chat. Renderer
  startup reopens the backend's active session silently so a reload hydrates
  persisted messages before new live events continue. `mergeChatHistory`
  reconciles replay with any global SSE events received during the request,
  preserving the live timeline's semantic interleaving, terminal tool states,
  and the longest streamed text/reasoning values.

- **Parent/child navigation** — `session.created` plus `session.list` maintain
  parent ids. Task cards use upstream's metadata-first, parent/title/agent
  fallback to open a child transcript, and child headers return to the parent.
  Timeline tool cards carry their panel's session so opening a file from a
  background panel focuses that panel first, and permission replies address
  the owning session.

- **Runtime-neutral transcript presentation** — `OpenCodeTimeline.tsx` renders
  the shared transcript shape; dormant DeepSeek metadata rendering remains in
  source, but the production app only opens OpenCode sessions. User messages use the subtle right-aligned layer bubble and final
  assistant markdown remains flat. Reasoning and tool calls form one calm work
  log with a shared vertical rail, uniform markers, and compact disclosures;
  final prose remains visually separate from that log. Each native step keeps a
  stable keyed entry and chronological position. A running Thinking summary
  follows the newest native reasoning or OpenCode commentary line. Native
  deltas appear immediately; a one-shot summary is never made to resemble token
  streaming. The full accumulated progress renders as Markdown when the user
  expands it. Tool rows expose running, failed, done, or duration state;
  structured progress is reduced to a readable phrase; live command output
  opens automatically, while failures keep their error visible inline and leave
  detailed I/O collapsed. Contiguous completed read/list/search calls collapse
  into an expandable exploration summary. Bottom-follow uses a stable signature to follow
  new business rows and turn-state changes before paint, while a resize observer
  follows streamed height growth only while the reader remains at the floor.
  Programmatic positions are tracked separately
  so inertial or deliberate reader scrolling is not mistaken for stream movement.
  A minimal inline working item exists only until the first concrete stream node
  arrives; no footer mirrors active reasoning or tools. Adjacent read/glob/grep/list
  parts remain individually visible across assistant messages; recursive
  dormant DeepSeek code-dispatch metadata stays nested beneath its root call;
  task calls use
  OpenCode's agent-colored delegation card and todo writes are hidden from the
  transcript in favor of the live prompt-dock checklist; edit/patch parts with
  `metadata.files` render a dedicated diff card (full path, +/− stat chips,
  expandable colorized unified diff, click-to-open in the editor pane) while
  remaining tools use flat BasicTool triggers.
  There is no assistant bubble, custom tool card, typing-dot placeholder, or
  stream cursor path.
- **Large-session fixture** — `large-session.performance.test.ts` deterministically
  reduces 2,400 events into 400 assistant messages and measures timeline-row
  derivation and retained output. After one warmup, median-of-five proxy budgets
  are 100 ms reducer/update time, 10 ms derived timeline time, at most 1,000
  estimated rows, and 8 KiB retained output per completed tool or shell result.
  A separate generous 5,000 ms budget measures React reconciliation and 800
  actual rows constructed in jsdom. It does not cover Chromium layout, paint,
  compositor work, or browser memory and is not a browser render budget.
- **Tree normalization** — `filterEntries` hides `HIDDEN_DIRS`; the main
  process `listDir` reads each directory directly from the filesystem
  (`fs.readdir`, with trailing slashes normalized away) rather than
  round-tripping through the opencode service, so the explorer refreshes
  instantly even while the service is busy streaming. Creating a file or
  folder also inserts the new entry into the tree and opens the new file tab
  optimistically in the renderer (`commitName`), with the authoritative
  `refreshTree`/`listDir` reconcile happening in the background.
  `.openshell-recovery` is hidden independently in main and renderer.
- **Drag-and-drop moves** — every explorer row is draggable; dropping onto
  a folder row moves the entry into it and dropping onto the empty tree
  area moves it to the workspace root. Self drops, drops into a folder's
  own descendant, drops onto the current parent, and file-onto-file drops
  are rejected by prefix containment checks in the sidebar (`canDrop`) and
  again in main. The hovered destination gets a drop indicator; a valid
  drop calls `moveEntry`, which performs the `shell:fs-move` invoke and
  remaps `tabs`, `activePath`, and `agentFiles` on success.
 - **External drag-and-drop** — OS file/folder drops are accepted with
  a file item/type in `DataTransfer` and routed through the main
  process, never interpreted as explorer moves. Dropping onto a folder row
  **imports** the items into that folder (`importPaths` →
  `shell:fs-import`, then the tree refreshes the destination); dropping
  files and folders onto the empty explorer area imports them into the current
   workspace without changing the active panels, except that a dropped folder
   at the root is opened as an additional workspace panel. The current workspace itself
  is rendered as a collapsible root row. Its entries can be hidden with
  **Remove from Workspace** without deleting their on-disk files; **Delete**
   remains the destructive filesystem action. Dropping files and folders into
   the **editor pane** opens them via `openPaths` (folders become panels, files
   become tabs); outside files save back to their absolute path via
   `shell:fs-write-standalone`. Dragging files onto the Welcome screen (no
   session yet) opens them via `openPaths`.
- **Recovery notice** — unacknowledged records are shown persistently with
  Open and Acknowledge actions. Acknowledge updates manifest metadata and hides
  the record without deleting bytes. Files and directories both offer inline
  Rename; main applies their distinct mutation policies documented in
  `docs/architecture.md`.

## Components (`src/renderer/src/components/`)

This table is an ownership map, not a prose copy of component implementation.
For pixel-level layout, responsive behavior, and ordinary presentation details,
inspect the owning component/SCSS and tests. Keep details here only when they
express a cross-component invariant or non-obvious state contract.

| Component | File | Responsibility |
|---|---|---|
| `App` | `App.tsx` | Top-level session/editor/sidebar/agent/terminal layout; panel geometry and focus routing |
| `Welcome` | `Welcome.tsx` | Landing view, recent sessions/workspaces, initial folder/file open |
| `FileSidebar` | `FileSidebar.tsx` | Sessions/Files navigation (defaults to Files when a workspace opens), Changes, Explorer, filesystem actions, terminal context actions |
| `SettingsSidebar` | `SettingsSidebar.tsx` | Settings navigation |
| `SettingsPage` | `SettingsPage.tsx` | Appearance, plugins, providers, safety, voice, default model and OpenCode sync, mobile, and about surfaces |
| `ProviderSettings` | `ProviderSettings.tsx` | Runtime-neutral provider connection/status UI; never owns provider secrets |
| `SessionsPane` | `SessionsPane.tsx` | Open-now inventory, saved workspaces, history, session open/close navigation |
| `EditorPane` | `EditorPane.tsx` | Monaco editor/diff tabs, save/conflict UI, editor validation entry points |
| `AgentPanel` | `AgentPanel.tsx` | Session-owned GUI/TUI surface, timeline, composer, model/agent controls, usage/status |
| `AgentTui` | `AgentTui.tsx` | xterm view for the active runtime's PTY-backed TUI |
| `OpenCodeTimeline` | `OpenCodeTimeline.tsx` | Runtime-neutral chronological rendering of assistant reasoning/text/tools/delegation |
| `OpenCodeTodoDock` | `OpenCodeTodoDock.tsx` | Structured todo/checklist state near the composer |
| `AgentTray` | `AgentTray.tsx` | Collapsed agent-panel affordance and session activity indication |
| `TerminalTray` | `TerminalTray.tsx` | Integrated terminal tabs backed by main-process `node-pty` |
| `ServerSettings` | `ServerSettings.tsx` | Settings inventory of active Vite preview servers with per-server and stop-all controls |

The terminal tray's server button passes the active workspace-relative HTML
tab to Vite when available, so nested standalone sites get the correct document
root. Startup is considered successful only for a reachable non-error page;
HTTP failures and bounded Vite stderr are shown in the tray instead of the
generic startup notice. Each workspace/page target runs its own preview server:
clicking the button toggles the server for the current page, and right-clicking
lists every running server for the workspace with per-server Stop (plus Stop all
when several run). The Settings **Servers** tab lists every running server
across workspaces with Stop and Stop all, and main stops all preview servers
when the app quits.

Key cross-component invariants:

- Every panel acts on its own session/workspace identity; background panels keep
  streaming independently.
- Opening a file/tool link from a background panel must address/focus the owning
  workspace rather than whichever panel was previously focused.
- Agent GUI and TUI are alternate views of the same session, not separate
  sessions. Approvals and forms are interactive, so the active surface owns
  them: the embedded TUI renders its own prompts in the terminal, and the panel
  dock is GUI-only — rendering it above the TUI asks the same question twice
  (the question skill is the visible case). Pending requests stay in session
  state and reconcile every three seconds plus stream reconnect so a missed
  `form.created` event cannot leave the agent waiting without a GUI card. A
  form whose owner is not an open session is routed to the panels open at the
  event's location using main's `orbitSessionIDs`, so a location-global form, a
  delegated child, or an external `opencode` TUI question surfaces in the GUI;
  the form keeps its true session id and replies carry it so the answer reaches
  the owning session. A temporary list failure preserves the existing card.
  Replies carry the form's session (or location) context.
  Pending requests remain in panel state regardless of active surface, so they
  appear in the dock when the panel returns to the GUI view.
- Timeline order comes from the authoritative chat/session state; components do
  not invent a second activity history.
- Workspace-dependent actions remain inert when no workspace is active.

## Styles (`src/renderer/src/styles/`)

`main.scss` is the single renderer stylesheet entry and uses ordered Sass
partials so the cascade stays explicit. Orbit's runtime-neutral chat tokens,
slots, typography, row geometry, and animations live in
`_opencode-chat.scss`; other component rules are owned by `_sidebar.scss`,
`_editor.scss`, `_agent.scss`, `_composer.scss`,
`_welcome.scss`, `_settings.scss`, `_sessions.scss`, and `_terminal.scss`; app-wide rules are separated into
`_foundation.scss`, `_layout.scss`, `_buttons.scss`, `_toasts.scss`, and
`_scrollbars.scss`. Vite CSS source maps are enabled in development, so
DevTools links inspected rules back to the partial and source line rather
than a generated `<style>` block or bundled CSS location. Runtime layout
measurements are passed as inline CSS custom-property values; their actual
presentational declarations remain in the owning SCSS partial.

Terminal input flows: keystrokes → `terminalInput(id, data)`; output
streams back via `onMessage` (`terminal-data`). The xterm `fit` addon +
`ResizeObserver` keep the PTY dimensions in sync (`terminalResize`), and the
agent TUI re-sends its fitted size once `agentTuiStart` resolves — a resize
that arrives before the PTY is registered is dropped by the terminal manager,
which would leave the TUI drawing only the spawn-default rows.
Agent TUI input uses the same terminal message stream and ownership checks, but
starts the active runtime command through `agentTuiStart` in the panel's
workspace directory. OpenCode uses `opencode --session <session-id>`; the
dormant DeepSeek runtime is not available to panels.
The persisted Kitty Glass appearance profile applies its transparent xterm
background, Kitty-inspired palette, and Fira Code fallback to the embedded TUI,
so the terminal shares the panel's glass instead of adding its own dark layer.
The window and native chrome track the theme's native appearance: the renderer
reports it through `setAppearance` on boot and on every theme change (dark for
Original and Kitty Glass, light for Paper), so the macOS `under-window`
vibrancy renders the dark material for the glass regardless of the system
appearance.
The renderer generates and registers each validated terminal UUID before
invoking `terminalStart`, so startup output or exit can be attributed even when
it arrives before the invoke resolves. Only those pending IDs can buffer startup output. Buffers retain at most 64 chunks / 256 KiB for ten
seconds and are cleared on exit, close, registration, or workspace reset.
Closing the final tab commits an empty tab state before hiding the tray;
reopening shows that empty state and requires the explicit `+` action to start
a new process. A natural final exit leaves the empty tray visible.
Explorer context-menu requests add and focus a terminal whose cwd is the selected folder or a selected file's parent, and expand the normal bottom tray.
When renderer HMR is newer than the still-running main/preload process, a missing resolved-cwd response triggers one safely quoted `cd`/`Set-Location` command through the existing terminal input channel, so folder terminals work without restarting Orbit.
The tray is toggled from the titlebar (⌥O) and drag-resized via the
`tray-divider`. Dragging the divider down to the bottom of the window
shrinks the tray to a 26px minimum and closes it only when the mouse is
released at that collapsed position.

## Monaco (`monaco.ts`)

- Workers wired for editor/json/css/html/ts (`?worker` imports).
- `orbit-original`, `orbit-paper`, and `orbit-kitty` themes (diff insert/remove colors included), selected with the persisted renderer color profile. Monaco
  parses theme palette colors with `Color.fromHex`, which silently maps any
  non-hex value to pure red — every palette color must be hex
  (`#RRGGBB` or `#RRGGBBAA`), never `rgba()`.
- `languageForPath()` — extension → Monaco language map (fallback
  `plaintext`).
- `editor-navigation.ts` binds Command/Control + Arrow Up/Down to the start/end
  of the document and Command/Control + Arrow Left/Right to the start/end of
  the current line. These explicit commands keep the native editor navigation
  behavior stable inside Electron.
- CSS worker diagnostics stay enabled (the only language worker with a
  working `doValidation`), so CSS files lint inline exactly like VS Code.
  The HTML worker ships no `doValidation`, so HTML files have no built-in
  structural markers — which also matches VS Code.
- Emmet is registered through `emmet-monaco-es` for HTML and CSS/SCSS/LESS.
  Typing an abbreviation shows up as a snippet completion (as in VS Code),
  and `emmet.ts` makes expansion deterministic: pressing **Enter** (or Tab)
  at the end of a recognized abbreviation — including `!` at the top of an
  HTML file — replaces it with the expanded markup through Monaco's snippet
  controller, so the caret lands on the first tab stop (the `<title>` text
  for `!`) without depending on the suggestion widget having finished
  opening. The key handling lives in `emmet-keys.ts` (`wireEmmetKeys`,
  called from the `EditorPane` edit editor's `onMount`) and is skipped
  while the suggestion widget is visible, while inside a `<script>` block,
  or while a snippet session is already active. `emmet.ts` mirrors the
  provider's noise checks (unknown tags, unresolved CSS values, unknown
  `.class` fragments) so Enter/Tab only expands genuine abbreviations.

## W3C editor validation

- The W3C checkers never run automatically. The **Validate** button appears at
  the bottom-right of `StatusBar` only for an open HTML or CSS file and runs them on demand for that
  HTML or CSS file. Preprocessor stylesheets (SCSS, LESS, Sass) are not
  validated — the W3C CSS Validator cannot parse them and would flag valid
  syntax as errors.
- `StatusBar` sends the active tab's content through
  `window.openshell.validateW3c`, applies the returned diagnostics as
  `w3c`-owner Monaco markers via `w3c-validation.ts`, and shows error and
  warning counts (or a failure state) beside the button.
- W3C markers are cleared whenever the file content changes or the tab
  closes, so stale line numbers never linger while editing.
- The main process calls the Nu Html Checker for HTML and the W3C CSS
  Validator for CSS, then returns diagnostics. Network failures leave the
  editor unchanged; Vue and Svelte files are not sent to the validators.

## Entry

`main.tsx` mounts `<App/>`; `App` renders its own `StoreProvider`. `index.html` is the
Vite entry. `global.d.ts` types `window.openshell` from the preload API.

Agent Mode is a temporary panel view. Normal coding mode renders only the
focused coding session. Entering Agent Mode seeds its panel set with that one
session; additional active sessions are loaded explicitly from the agent
panel's three-dots menu, up to eight visible panels. Three or more panels use
a two-row grid that expands from two through four columns. Exiting Agent Mode resets the temporary set to the
currently focused session, while all other active sessions remain available in
the menu and continue running in the backend. Selecting a hidden session in
normal mode switches the single coding workspace; selecting one in Agent Mode
attaches it to the visible panel set and focuses it.
