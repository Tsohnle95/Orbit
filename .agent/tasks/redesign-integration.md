# Redesign integration

Status: ACTIVE

## Goal

Integrate the committed UI/features from the Codex redesign copy into the refactored Orbit main workspace, retaining the new subsystem ownership and existing capabilities.

## Acceptance criteria

- [ ] Inventory every redesign delta from common ancestor, including tests/docs/scripts; preserve source checkout unchanged.
- [ ] Integrate independent appearance/shell selection, redesigned chrome/tree/sessions/composer, editor strip/status menu and browser tabs.
- [ ] Place directory prefetch in WorkspaceFiles; preserve private state owners, generation guards, recovery/save and streaming behavior.
- [ ] Characterize browser isolation and lifecycle, correct demonstrated integration defects, and validate actual UI.
- [ ] Supported npm run check and relevant native/platform checks pass for each checkpoint; review actual diffs and cumulative result.

## Relevant context

Main begins clean at 0cf9652. Redesign begins clean at ee8d298; common ancestor is 3e63792433ef7a6d2ff04540a7181458d953d7a5 (not original campaign baseline). The redesign contains 75 changed paths, no dependency changes. Source: /Users/tdawg/.local/share/opencode/worktree/b865fa/orbit-codex-redesign.

Canonical docs: AGENTS.md, docs/agent-execution.md, docs/architecture.md, docs/renderer.md, docs/main.md, docs/operations.md, docs/sass.md.

## Invariants / constraints

- Preserve main/preload/renderer trust boundaries, sole OpenCode SDK authority, current IPC contracts, private owners and state sequencing.
- Port feature deltas, never replace refactored Store with the earlier monolith or restore stale architecture manifests/docs/task ledgers.
- Do not install the design-copy default userData directory into the production workspace; preserve normal user data and source copy.
- External web guests receive no application preload/Node privileges or IPC authority; main enforces navigation/session policy.
- No resets/stashes/cleans or unrelated user work; main/source clean at entry.

## Affected surfaces

Appearance/theme/settings/Monaco; App/rail/titlebar; file tree/session list/agent composer; editor activity/tabs/status; isolated browser state/guests; main browser policy; WorkspaceFiles directory cache; docs and fitness configuration.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 0 | Branch delta inventory and independent plan review | complete | baseline1326-test canonical; three bounded discovery reviews | — |
| 1 | Independent appearance/shell and syntax palettes | complete | 20 targeted/type; isolated canonical; native settings palette/shell independence; independent approval | checkpoint pending |
| 2 | Main browser isolation and navigation foundation | pending | guard/trust/permission tests, platform, canonical | — |
| 3 | Chrome/session/tree/agent/editor/browser presentation and owner integration | pending | owner/guest/layout tests, platform/native UI, canonical | — |
| 4 | Cumulative review, feature parity, docs/guardrails cleanup | pending | full canonical/platform + independent review | — |

## Validation plan

Node22.23.2. Keep source comparison frozen at ee8d298 and initial main 0cf9652. Port unchanged file deltas directly; three-way merge overlapping files and explicitly reimplement Store additions through current owners. Existing upstream style pins remain unchanged. New production files must have canonical ownership routes; size/complexity rules remain meaningful, exceptions require evidence and review rather than blanket rebaselining.

## Decisions

- 2026-10-14 — Read-only discovery uses three Sol6.1/low agents under canonical parallel-discovery policy. Root coordinates edits; no concurrent writes to shared files.
- 2026-10-14 — Design-copy isolation defaults and stale architecture/task documents are source-workspace scaffolding, not main features. Preserve normal main profile and canonical documentation; update relevant feature sections only.

- 2026-10-14 — Independent plan review: browser main security foundation precedes shared chrome, because App/titlebar/editor imports form one feature integration. Browser actions stay independent of Store updates; group metadata/actions use local tab identity.

## Open risks / blockers

- Browser URL-initialized tab does not mount/navigate a guest; failure clearing and permission isolation require characterization before porting.
- Inline directory prefetch and file/browser activation wrappers require integration into refactored owners.
- Split editor status menus must target the local group file rather than the global focused file.

## Completion

- [ ] Inventory/parity reviewed
- [ ] Final validation and independent review passed
- [ ] Durable facts in canonical docs
- [ ] Future work in normal backlog
- [ ] Delete completed temporary task file in completion checkpoint

- 2026-10-14 — Phase1 exact isolated snapshot uses physical bundled dependencies (symlinked Vite worker paths rejected outside snapshot root, no source failure). Supported canonical gate and native disposable UI passed; saved theme IDs retained. Current main browser/renderer feature work excluded from this snapshot and commit.
