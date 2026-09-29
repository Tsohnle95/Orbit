# Orbit GitHub updater and tray fixes

Status: ACTIVE

## Goal

Add a safe, user-triggered updater for the Orbit `main` checkout, restore the
titlebar Settings entry, and make every open workspace root removable from the
Explorer context menu.

## Acceptance criteria

- [ ] About can check the canonical GitHub `main` branch and show whether an
  update is available; Update fetches, fast-forwards, refreshes dependencies,
  rebuilds, and restarts Orbit.
- [ ] The updater refuses dirty trees, non-`main` branches, and noncanonical
  remotes without changing source files.
- [ ] Every open Explorer workspace root offers Remove Workspace for its own
  panel, including nonfocused roots.
- [ ] Settings is available in the titlebar immediately after Terminal.
- [ ] `npm run check` passes on the repository-supported Node version.

## Relevant context

Canonical docs:
- `docs/main.md`, `docs/preload.md`, `docs/shared.md`
- `docs/renderer.md`, `docs/operations.md`

Implementation / tests:
- `src/main/index.ts`, `src/main/app-updater.ts`
- `src/preload/index.ts`, `src/shared/types.ts`
- `src/renderer/src/App.tsx`, `src/renderer/src/components/SettingsPage.tsx`
- `src/renderer/src/components/FileSidebar.tsx`, `src/renderer/src/store.tsx`

## Invariants / constraints

- The main process owns Git and process execution; renderer uses only trusted
  preload IPC.
- Updates are explicit and fast-forward only. Never stash, reset, clean, or
  overwrite a dirty worktree.
- The existing OpenCode updater remains separate.
- Explorer removal closes the addressed panel and does not delete its files or
  remove a saved-workspace bookmark.

## Affected surfaces

- Main/preload/shared IPC for app update status and execution.
- About settings for check/update feedback and restart.
- Explorer context-menu identity for open workspace roots.
- Titlebar and activity rail settings entry points.
- Relevant docs and regression tests.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | GitHub updater contract, main implementation, About UI | complete | targeted updater/settings tests; `npm run check` on Node 22.23.2 | `745b234` |
| 2 | Workspace-root context target and removal | complete | targeted FileSidebar context-menu test; `npm run check` on Node 22.23.2 | — |
| 3 | Restore titlebar Settings entry and update docs | pending | App layout test, docs check, then `npm run check` | — |

## Validation plan

- Targeted checks: updater status/update tests; FileSidebar context-menu test;
  App layout/settings tests.
- Integration/platform/manual checks: inspect updater branch/dirty-tree guards
  and titlebar control placement; live GitHub update cannot be safely exercised
  against the working checkout during implementation.
- Final gate: `npm run check` under Node 22.23.2.

## Decisions

- 2026-09-29 — Track `origin/main` for the canonical `Tsohnle95/Orbit` remote.
  Local edits and branch divergence are reported for manual resolution instead
  of being stashed or discarded.
- 2026-09-29 — Put app-update controls in Settings → About, following the
  Hermes-style check/apply/restart interaction; do not update automatically.
- 2026-09-29 — Remove the duplicate Settings gear from the activity rail after
  restoring it in the titlebar; keep the Files rail entry.

## Open risks / blockers

- Updating requires GitHub network access, npm registry access when the lockfile
  changes, and a compatible Node/npm installation on the source checkout.
- A full live fetch/build/restart is not part of automated verification.

## Completion

Before deleting this task file:

- [ ] All acceptance criteria satisfied
- [ ] Final integration validation passed
- [ ] Durable truths updated in canonical docs
- [ ] Follow-up work moved to issues/backlog
- [ ] Final Git state reviewed
