# OpenCode response presentation parity

Status: ACTIVE

## Goal

Make the agent panel response surface match the pinned OpenCode GUI implementation, including layout, styling, Markdown rendering, tools, and streaming transitions.

## Acceptance criteria

- [x] Match the current upstream default response layout, including user bubble, assistant parts, tool grouping, spacing, and hover actions.
- [x] Use upstream typography, Markdown structure/styles and real syntax highlighting while preserving the user's later background/code color and responsive wrapping fixes.
- [x] Preserve upstream intermediate streaming Markdown structure and completion behavior.
- [ ] Verify representative response states against upstream source and a rendered reference at equal widths, plus the actual Orbit panel.
- [x] Pass supported Node canonical gate; preserve user workspace/session and unrelated edits.

## Relevant context

- Canonical docs: `docs/renderer.md`, `docs/events.md`, `docs/agent-execution.md`.
- Implementation: `OpenCodeTimeline.tsx`, `_opencode-chat.scss`, Markdown projection and chat store.
- Reference: `/private/tmp/orbit-opencode-reference`, revision `03e67171ab2dc1e7f16e8cebfbc7f778f61b89f0`.
- Prior three commits fixed some pacing/state behavior but did not establish visual parity. User explicitly identified overall layout/styling as wrong.

## Invariants / constraints

- Main process retains OpenCode connection ownership and renderer remains the authoritative chat projection.
- Keep external links behind the existing bridge; sanitize rendered Markdown.
- Preserve `mockup-design/iterations/explore.html` pre-existing edit.
- Final gates use Node 22.23.2.
- 2026-09-29: Other agents have made unrelated committed and uncommitted changes (mobile onboarding, sidebar, terminal, panel menus). Preserve all. The user explicitly requires retaining their background/code color and wrapping fixes in `_opencode-chat.scss`.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | Audit actual default upstream path and replace response layout/style/Markdown approximations | complete | Source audit; real Markdown/Pierre and lifecycle tests; Node 22.23.2 canonical gate, 110 files / 870 tests | `75b2710` |
| 2 | Compare reference and Orbit intermediate/final response UI and correct discrepancies | active; final live checks blocked by UI connection | Equal-width reference at 420 px done; narrow/wide, light appearance, latest tools and actual Electron panel pending | — |
| 3 | Preserve complete OpenCode tool/shell output through live projection and replay | complete | Four long-output regressions failed on the old cap; 18 targeted tests and Node 22.23.2 canonical gate pass | this checkpoint |

## Decisions

- Match actual app `message-timeline` path rather than assuming the standalone `session-turn` component is the app's render path.
- Port upstream presentation sources with provenance and scope style tokens to the response surface. Keep Orbit's application shell and session ownership.
- Independently audit reference behavior and implement Markdown in separate new files; root owns timeline/layout integration and final review.
- Review outcome: do not equate passing unit tests or a single streamed prompt with complete visual equivalence. Use rendered reference comparisons for the user's reported mismatch.

## Validation / risks

- Existing local tests encode custom Orbit layout and must be revised to upstream behavior, not retained as a parity oracle.
- Actual upstream default app path and source verified at revision `03e67171`. Source V2 styles, worker/marked/KaTeX/Shiki/morphdom Markdown, metadata footers, generic/special tools, file accordions/Pierre and tooltip lifecycle are implemented.
- The upstream and Orbit fixtures at width 420 matched measured user bubble, assistant text, heading and code-block positions/sizes. Corrected inherited line height/weight and old narrow-padding overrides afterward. Shiki tokens rendered in the browser under Orbit's unchanged CSP. Wrapping is an explicit user exception.
- Latest supported gate: `npm run check`, Node 22.23.2, 110 test files / 870 tests, typecheck/docs/production build pass. Log `/private/tmp/orbit-response-parity-check.log`.
- The staged port also passes independently of concurrent mobile/menu/palette edits: 109 test files / 861 tests plus typecheck/docs/build. Log `/private/tmp/orbit-parity-checkpoint-check.log`. The temporary snapshot's Vitest filesystem allowlist includes the symlinked dependency directory; product configuration is unchanged.
- Complete-output gate: `npm run check`, Node 22.23.2, 110 files / 871 tests plus typecheck/docs/build. Log `/private/tmp/orbit-output-parity-check.log`. The 400-turn fixture retains 13,107,200 supplied characters exactly once with 6.05 ms median reduction and 0.16 ms derivation in the targeted run. Operations docs were then aligned and `npm run docs:check` rerun.
- Native UI failed repeatedly with `Sky Computer Use native pipe startup failed`, including after reset and the latest continuation. Inventory has no apps/browsers. Do not claim full visual equivalence or completion while final live checks remain unavailable.
- Pending direct checks: repeat 320/420/700 comparison after final tool/CSS edits; light appearance; streaming code and copy/tooltip interactions; file accordions; actual restarted Electron agent panel. Real upstream harness `/private/tmp/orbit-opencode-visual-reference` uses port 8766; actual Orbit renderer harness `/private/tmp/orbit-parity-fixture` uses port 8767.
- Preserve other agents' mobile/menu changes and the user's palette/wrapping overrides without staging or committing their work.
- Orbit's external-link bridge remains an architectural constraint; the presentation port does not establish complete upstream application equivalence. The 8 KiB output cap was an observable mismatch and is removed while preserving session LRU eviction and duplicate-content cleanup.
