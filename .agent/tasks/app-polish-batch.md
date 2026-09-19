# App interaction and runtime polish batch

Status: ACTIVE

## Goal

Resolve the seven reported editor, panel, explorer, preview-server, external-rename, keyboard, and GUI-question failures without regressing workspace isolation or recovery behavior.

## Acceptance criteria

- [ ] Text entry no longer invokes application spellcheck/autocorrect.
- [ ] Agent Mode supports and lays out up to eight panels; the ninth is blocked.
- [ ] Explorer context menus rename both files and folders safely.
- [ ] Vite preview startup either opens a reachable page or reports the actionable startup failure.
- [ ] An externally renamed open file follows the new path when the move can be identified; ambiguous deletion remains recoverable without repeated errors.
- [ ] Command/control plus arrow keys navigate to editor document/line boundaries.
- [ ] Pending agent questions render and remain actionable in GUI mode, including after missed live events.
- [ ] Existing workspace identity, no-replace, TUI prompt ownership, and save-conflict invariants remain intact.

## Relevant context

Canonical docs:
- `docs/agent-execution.md`
- `docs/architecture.md`
- `docs/main.md`
- `docs/preload.md`
- `docs/renderer.md`
- `docs/events.md`
- `docs/shared.md`
- `docs/operations.md`

Implementation / tests:
- `src/main/index.ts`, `src/main/opencode.ts`, `src/main/vite-server.ts`
- `src/renderer/src/App.tsx`, `src/renderer/src/store.tsx`
- `src/renderer/src/components/{AgentPanel,EditorPane,FileSidebar,FormPrompt,TerminalTray}.tsx`
- Nearby main, store, and component tests.

## Invariants / constraints

- Filesystem mutations remain confined to the generation-bound workspace and never replace an existing destination.
- External move correlation must be identity-based; equal-content files are not sufficient evidence.
- Interactive prompts remain GUI-only when the panel is in GUI mode and TUI-owned in TUI mode.
- Pre-existing changes under `.commandcode/` and `resources/icon.*` are not modified or committed.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | Autocorrect, eight-panel layout, editor navigation | complete | targeted renderer/main tests + Node 22 `npm run check` | `4e24c31` |
| 2 | Explorer file/folder rename | complete | mutation + sidebar/store tests + Node 22 `npm run check` | `3c42aef` |
| 3 | External rename correlation and open-tab recovery | complete | watcher/store tests + Node 22 `npm run check` | checkpoint pending |
| 4 | Vite preview diagnosis and robust failure reporting | active | Vite manager/tray tests + live loopback smoke | — |
| 5 | GUI question event/reconciliation compatibility | pending | event/store/panel tests + runtime smoke where possible | — |
| 6 | Integration review, docs, final supported-Node gate | pending | `npm run check` + focused UI/runtime smoke | — |

## Validation plan

- Targeted checks: affected Vitest files and TypeScript configs per phase.
- Integration/platform/manual checks: Vite loopback launch; renderer behavior via the narrowest available Electron/CDP smoke; runtime form inventory/event compatibility.
- Final gate: confirm Node `22.23.2`, then `npm run check`.

## Decisions

- 2026-09-18 — Use a small batch ledger because the request spans independent logical units and multiple checkpoints.
- 2026-09-18 — Preserve ambiguous external deletes; only migrate an open tab when main can correlate old and new paths by filesystem identity.
- 2026-09-18 — Keep form APIs as the canonical question transport for installed beta-19242, and add compatibility at event normalization/reconciliation rather than inventing legacy endpoints.

## Open risks / blockers

- The active shell is Node 26.7.0; final validation must be rerun with repository-supported Node 22.23.2.
- Live question reproduction depends on an agent turn reaching the form tool; automated compatibility and reconciliation tests are required even if that smoke is unavailable.

## Completion

- [ ] All acceptance criteria satisfied
- [ ] Final integration validation passed
- [ ] Durable truths updated in canonical docs
- [ ] Follow-up work moved to issues/backlog
- [ ] Final Git state reviewed
