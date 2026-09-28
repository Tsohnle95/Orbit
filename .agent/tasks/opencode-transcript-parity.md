# OpenCode transcript streaming parity

Status: ACTIVE

## Goal

Render Orbit's assistant activity stream with OpenCode's own session-ui
mechanism so context reads stop flooding the transcript and the streaming
transcript matches OpenCode's behavior and DOM.

Reference source (read-only checkout):
`/private/var/folders/2c/yclwsfy55cl2msp46fvwk8wc0000gn/T/opencode/opencode-src`
at `b471c2b`, `packages/session-ui/src/components/`.

## Acceptance criteria

- [ ] Context tools (`read`/`list`/`glob`/`grep`) always render inside a
      `ContextToolGroup` (contiguous runs of length >= 1), matching OpenCode's
      `groupParts`/`isContextGroupTool`.
- [ ] The group trigger shows a `ToolStatusTitle` (`Exploring` -> `Explored`)
      plus an `AnimatedCountList` summary (`{{count}} read(s)`, `search(es)`,
      `list(s)`), matching OpenCode's DOM slots and English copy.
- [ ] Expanding the group reveals compact inline rows (title/subtitle/args),
      not full nested tool cards.
- [ ] Non-context tools render as compact inline triggers (no bordered card);
      a running tool shimmers its title.
- [ ] Existing transcript behavior stays: copy/revert options, permission
      prompts, subagent links, todo dock, retries, errors, shell timeline rows.
- [ ] `npm run check` passes; visual verification recorded.

## Relevant context

Canonical docs:
- `docs/renderer.md` (transcript rendering section)
- `AGENTS.md` (execution modes)

Reference (OpenCode):
- `components/message-part.tsx` (`groupParts`, `isContextGroupTool`,
  `contextToolTrigger`, `contextToolSummary`, `ContextToolGroup`)
- `components/basic-tool.tsx`, `components/tool-status-title.tsx`
- `components/tool-count-summary.tsx`, `components/tool-count-label.tsx`
- `components/*.css` (`basic-tool.css`, `message-part.css`, `tool-status-title.css`,
  `tool-count-summary.css`, `tool-count-label.css`, `animated-number.css`)
- `packages/ui/src/i18n/en.ts` (copy)

Implementation / tests:
- `src/renderer/src/components/OpenCodeTimeline.tsx`
- `src/renderer/src/components/OpenCodeTimeline.test.tsx`
- `src/renderer/src/styles/_opencode-chat.scss`

## Invariants / constraints

- `data-timeline-row` scaffold and ordering must remain stable (timeline tests
  assert exact row sequences).
- Main/preload/renderer boundaries unchanged; this is renderer-only.
- Generic tool args must not leak arbitrary input values (Orbit privacy
  behavior); context-tool args are the documented `offset`/`limit`/`pattern`/
  `include` fields only.
- No new runtime dependencies, except the phase-4, user-approved `marked` +
  `remend` port that matches OpenCode's exact stack.

## Affected surfaces

- `OpenCodeTimeline.tsx` activity grouping + context group + tool trigger.
- New `ToolStatusTitle.tsx`, `ToolCountSummary.tsx` renderer components.
- `_opencode-chat.scss` transcript tool/context styling.
- Transcript tests + `docs/renderer.md`.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | Context-tool streaming core: ToolStatusTitle, count summary, grouping semantics, ContextToolGroup DOM, inline tool triggers | done (72d232f) | unit tests + visual | 72d232f |
| 2 | Non-context surfaces parity: shell/edit/write/patch body, generic "Called" trigger, tool error card, `partDefaultOpen` | done | unit tests + visual | 4850432 |
| 3 | Assistant turn parity: parts grouping across messages, reasoning/text part parity | done | unit tests + visual | bc9fdde |
| 4 | Markdown streaming parity (paced projection / fence healing) | done | unit tests + visual | b94a605 |
| 5 | CSS parity pass + full visual sweep | pending | visual + `npm run check` | — |

## Validation plan

- Targeted: `npx vitest run src/renderer/src/components/OpenCodeTimeline*`
- Manual/visual: temporary harness rendering the real `OpenCodeTimeline` with
  real SCSS; shut every started server down before reporting.
- Final gate: `npm run check` under Node 22.23.2.

## Decisions

- 2026-09-27 — Port OpenCode's transcript mechanism rather than re-invent; use
  its DOM slots and English copy so future diffs stay comparable.
- 2026-09-27 — Keep Orbit's `data-timeline-row` scaffolding (invisible to users)
  to avoid destabilizing turn/retry/error tests; align visible tool DOM.
- 2026-09-27 — Group a contiguous run of context tools of length >= 1 (OpenCode
  behavior) instead of Orbit's previous >= 2 rule.
- 2026-09-27 — Preserve Orbit's generic-tool argument privacy (do not dump
  arbitrary input) while adopting OpenCode's inline trigger structure.
- 2026-09-27 — Failed tools render OpenCode's `ToolErrorCard` (error head as
  subtitle, cleaned error body expandable, copy-on-hover) in place of the old
  inline error summary; a failed read still folds into its context group.
- 2026-09-27 — Shell tools adopt OpenCode's `bash-output` body (`$ command`
  plus output in one scrollable pre with a copy affordance); edit/write/patch
  render an inline diff body instead of a bordered card; unrecognized tools use
  OpenCode's `Called \`{tool}\`` trigger.
- 2026-09-27 — `partDefaultOpen` is not ported as a live default: OpenCode only
  opens shell/edit by default when the host passes `shellToolDefaultOpen`/
  `editToolDefaultOpen`, which Orbit does not expose. Orbit keeps its own
  running-shell auto-open and leaves edit bodies collapsed.
- 2026-09-27 — Turn parity matches OpenCode's app timeline: contiguous assistant
  messages form one run and their parts are flattened before `groupParts`, so a
  context run can span message boundaries. Reasoning is hidden
  (`showReasoningSummaries: false`) and represented only by OpenCode's turn-level
  `session-turn-thinking` row (shimmer `Thinking` plus `reasoningHeading`), shown
  while the active turn is busy and error/retry-free. Orbit's collapsible
  per-part `Thought`, its statusText-driven `inline-working` row, and the related
  CSS were removed.
- 2026-09-27 — Phase 4 adopts OpenCode's exact markdown streaming stack. Orbit's
  declarative `react-markdown` stays the block renderer, but block boundaries and
  healing come from a verbatim port of OpenCode's `markdown-stream.ts` +
  `markdown-projection.ts` using OpenCode's pinned `marked` and `remend`; this is
  the one approved exception to the no-new-dependency constraint. OpenCode's
  imperative DOM/worker/cache renderer is not ported.

## Open risks / blockers

- Orbit's `ToolCallView` is not the SDK `Part` shape; `title`/`subtitle` continue
  to come from `toolPresentation()`.
- Phase 4 (markdown streaming) depends on evaluating `marked`/remend ports
  against the current `react-markdown` pipeline; may remain out of scope if the
  cost outweighs observable benefit.

## Completion

Before deleting this task file:

- [ ] All acceptance criteria satisfied
- [ ] Final integration validation passed
- [ ] Durable truths updated in canonical docs
- [ ] Follow-up work moved to issues/backlog
- [ ] Final Git state reviewed
