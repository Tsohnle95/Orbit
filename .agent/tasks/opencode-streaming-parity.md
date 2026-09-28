# OpenCode desktop streaming parity

Status: ACTIVE

## Goal

Make Orbit's agent panel present a live OpenCode response with the same text progression, part ordering, completion behavior, and visible activity transitions as the OpenCode desktop/web session UI at upstream commit `03e67171ab2dc1e7f16e8cebfbc7f778f61b89f0`.

## Acceptance criteria

- [ ] Large text snapshots advance with OpenCode's 24 ms pacing, 512 character immediate threshold, and word boundary snapping; short deltas remain immediate, and completion flushes the full text.
- [ ] Streaming markdown follows assistant message completion, preserving live rendering across a completed text part until its message ends.
- [ ] Canonical part snapshots and live deltas appear in OpenCode's ordered message/part sequence, including out of order arrival and reconnect hydration.
- [ ] The active turn shows OpenCode's working/retry/error transitions without duplicate or stale activity.
- [ ] Existing Orbit session routing, tool actions, file links, and composer behavior continue to work.
- [ ] Targeted component/protocol checks, canonical gate, and a direct UI/integration smoke pass.

## Relevant context

Canonical docs: `docs/events.md`, `docs/renderer.md`, `docs/architecture.md`.

Implementation: `src/main/stream-pipeline.ts`, `src/renderer/src/chat-store.ts`, `src/renderer/src/components/OpenCodeTimeline.tsx`, `src/renderer/src/markdown-stream.ts`, nearby tests.

Reference: OpenCode `packages/session-ui/src/components/message-part.tsx`, `session-turn.tsx`, `markdown-stream.ts`; `packages/app/src/context/server-session.ts` and `server-sdk.tsx` at the pinned commit.

## Invariants / constraints

- Main remains the only OpenCode client; session streams remain independent.
- Authoritative snapshots and recovery must not shrink or duplicate live content.
- Do not touch the pre-existing `mockup-design/iterations/explore.html` edit.
- Exact upstream visual behavior is scoped to live response presentation inside Orbit's agent panel; Orbit's app shell and branding remain its own.

## Affected surfaces

- Text rendering: pacing and Markdown live/completed mode.
- Chat projection: ordered parts and per-message completion.
- Timeline: working indicator, prose/activity placement, copy/action behavior.
- Documentation and regression tests for durable behavior.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 1 | Reproduce and correct text pacing and message completion | complete | 819 tests and canonical gate passed on Node 22.23.2 | `422bc3f` |
| 2 | Audit and correct part order/activity transitions against upstream | complete | 823 tests and canonical gate passed on Node 22.23.2 | pending checkpoint |
| 3 | Direct UI/integration comparison, docs, final review | active | Smoke, `npm run check` | — |

## Validation plan

- Targeted Vitest tests for paced text, text part lifecycle, reconnect/out of order messages, and activity state.
- Compare DOM chronology and visible text over time against the pinned upstream source and tests.
- Run `npm run check` with Node `22.23.2` from `.node-version` at checkpoints.
- Run the narrowest available full process live agent panel smoke or report the exact unavailable surface.

## Decisions

- 2026-09-27 — Use OpenCode desktop/web UI as the reference because the request names the GUI agent panel; OpenCode's TUI is a different presentation.
- 2026-09-27 — Port observable streaming semantics into Orbit's React components instead of importing Solid components across the renderer boundary.
- 2026-09-27 — Preserve Orbit's workspace/session ownership and existing actions while matching the response stream.
- 2026-09-27 — Order canonical `prt_` parts by OpenCode ID and V2 synthetic parts by server event sequence. Their identifiers encode different ordering information.
- 2026-09-27 — Preserve distinct parts and assistant messages with repeated text. OpenCode identifies them by ID and renders each; content equality is not message identity.

## Open risks / blockers

- A live upstream desktop comparison may depend on locally available providers or application binaries; source/test parity can still be checked directly.
