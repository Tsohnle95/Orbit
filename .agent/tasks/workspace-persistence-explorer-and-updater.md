# Workspace persistence, explorer selection, and update UX

Status: ACTIVE

## Goal

Keep saved workspaces and conversation history available across launches, add VS Code-style multi-selection and bulk file operations, and make validation/update actions visible and verifiable.

## Acceptance criteria

- [ ] Saved workspace bookmarks survive renderer reloads and app rebuild/relaunch without being overwritten by an empty or unreadable browser-storage value.
- [ ] Orbit does not permanently delete old OpenCode sessions automatically, and recents are not hidden only because of age.
- [ ] Explorer supports modifier/shift selection, bulk trash, and dragging multiple selected files/folders to another folder.
- [ ] Status bar always shows the HTML/CSS validation control; it is disabled with a clear explanation when there is no supported active file.
- [ ] About has a direct update action that opens the progress window, fetches canonical GitHub `main`, installs dependencies, rebuilds, and relaunches; current/blocked/failure results are visible.
- [ ] Existing workspace confinement, recoverable Trash deletion, and source-checkout updater safeguards remain intact.

## Relevant context

Canonical docs:
- `docs/renderer.md`
- `docs/main.md`
- `docs/preload.md`
- `docs/operations.md`

Implementation / tests:
- `src/renderer/src/store.tsx`, `src/renderer/src/components/FileSidebar.tsx`, `src/renderer/src/components/StatusBar.tsx`, `src/renderer/src/components/SettingsPage.tsx`
- `src/main/index.ts`, `src/main/app-updater.ts`, `src/main/opencode.ts`, `src/preload/index.ts`, `src/shared/types.ts`
- nearby store, sidebar, statusbar, updater, and retention tests

## Invariants / constraints

- Main remains the owner of filesystem confinement, safe moves, Trash, and durable app data; the renderer never receives an arbitrary filesystem path for deletion/move.
- Bulk operations skip nested selections when an ancestor is also selected, and move each selected top-level path through the existing validated IPC.
- Saved workspace hydration must finish before renderer state can be persisted; a failed read must never cause an empty write.
- GitHub updates continue to require a clean canonical `main` checkout and a supported Node toolchain.

## Affected surfaces

- Renderer store and Welcome: migrate workspace bookmarks to durable main-owned storage and preserve legacy localStorage values.
- OpenCode session inventory: remove automatic destructive expiry and keep old conversations discoverable.
- Explorer: add selection state and bulk operation routing while preserving file-open and directory-expand behavior on ordinary clicks.
- Status bar and About: expose validation consistently and start the updater directly from a visible action.
- IPC/preload/shared docs and operations docs: keep newly changed persistence and updater behavior accurate.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | Durable workspace bookmarks and non-destructive session history | complete | targeted persistence/retention tests; `npm run check` (pass) | pending |
| 2 | Explorer multi-select, bulk delete, and multi-path drag/move | pending | sidebar/store mutation tests; `npm run check` | — |
| 3 | Always-visible validation and direct popup updater action | pending | statusbar/settings/updater tests; `npm run check`; build and inspect | — |

## Validation plan

- Targeted checks for each phase, followed by the canonical `npm run check` under Node 22.23.2.
- Inspect the built renderer for the validation control and check that updater progress UI is present in the main build.
- Do not close the user's running Orbit process during this task; the currently open workspace has a terminal panel and restarting the process would interrupt it. Report that a full process restart is needed for the running process to load newly registered main-process handlers.

## Decisions

- 2026-09-30 — Store saved-workspace bookmarks in an atomic main-process file with a last-known-good backup and merge any valid legacy localStorage bookmarks during hydration. The current localStorage-only effect can turn a parse/read failure into a persistent empty list.
- 2026-09-30 — Import OpenCode's project catalog only when the durable bookmark store is uninitialized and no valid legacy bookmark key exists. The snapshot's initialized flag prevents a deliberately emptied bookmark list from being repopulated on later launches.
- 2026-09-30 — Stop automatically pruning or age-filtering OpenCode sessions. The current 24-hour / 30-day cleanup permanently calls `session.remove`, which matches the reported history loss and is not reversible.
- 2026-09-30 — Keep validation visible but disabled without an active HTML/CSS tab, so the requested bottom-left control is always discoverable.
- 2026-09-30 — Give About an explicit update action that invokes the existing main-process popup flow; retain a separate check action for status reporting.

## Open risks / blockers

- The running Orbit window reported no registered `shell:app-update-check` handler before this task; source and compiled main output contain the handler. Renderer reloads cannot register a missing main-process handler, so the running process will need a full quit/reopen after work is verified.

## Completion

- [ ] All acceptance criteria satisfied
- [ ] Final integration validation passed
- [ ] Durable truths updated in canonical docs
- [ ] Follow-up work moved to issues/backlog
- [ ] Final Git state reviewed
