# Architecture optimization

Status: ACTIVE

## Goal

Reduce unnecessary production implementation and decompose responsibilities while preserving Orbit's established architecture, behavior, and routing.

## Acceptance criteria

- [ ] Reproducible production LOC/file/complexity/dependency/duplication/build baseline and final inventory; report gross and net reductions honestly.
- [ ] Evaluate all eight priority modules, SCSS, auxiliary code, dormant source, and assets; implement defensible cohesive changes.
- [ ] Preserve successful and failure behavior, IPC contracts, trust boundaries, generations, recovery, concurrency, streaming, unsaved edits, terminals, selections, mobile, packaging.
- [ ] Measure identical representative performance workloads before/after; reject material regressions.
- [ ] Enforce module/function budgets, dependency direction, cycles, private ownership, and substantial new duplication through canonical check/CI.
- [ ] Canonical routes and ownership remain sufficient and current; independent review finds no critical unresolved regression.
- [ ] Every implementation checkpoint passes supported-toolchain canonical and relevant integration verification.

## Relevant context

Canonical docs: `AGENTS.md`, `docs/agent-execution.md`, `docs/architecture.md`, `docs/main.md`, `docs/renderer.md`, `docs/events.md`, `docs/operations.md`; route to preload/shared/Sass docs as affected.

Baseline: clean working tree, main at `a1c54a35c3856e56209110cf4db493754699ed00`. Node `.node-version` = 22.23.2, engines >=22.23.2 <23. Supported toolchain: `/Users/tdawg/.local/share/orbit-toolchains/node-v22.23.2/bin`.

## Invariants / constraints

Protected inventory is owned by the existing canonical docs: main exclusively owns OpenCode/privileged operations, preload is a sandboxed controlled bridge, renderer owns UI/chat state, shared owns public contracts; OpenCode V2 enabled and DeepSeek retained dormant. Preserve AGENTS routing, execution policy, canonical ownership, public IPC payloads/error semantics, workspace/session/generation identity, and event/state authority. No protected contract changes without separate approval.

No deletions of features, tests, security/error handling, intentionally retained assets, or user work. No metric scope changes, source minification, excluded-code relocation, speculative bug fixes, or architectural frameworks. Exclusive implementation ownership; coordinator integrates and commits.

## Affected surfaces

Backend lifecycle, filesystem/replay, renderer state/projection, UI composition, styles, tooling/CI; exact slices depend on evidence-backed discovery and adversarial review.

## Phases

| Phase | Scope | Status | Validation | Commit |
|---|---|---|---|---|
| 0 | Baseline and characterization | complete | frozen metrics/hash inventory; supported check/platform; reproducible benchmark | pending metrics checkpoint |
| 1 | Responsibility maps and reviewed extraction design | complete | Agent F adversarial review; resolutions below | — |
| 2a | Pure session replay and identical shared presentation normalization | complete | 73 targeted tests; 993 full tests/type/docs/build; independent AST equivalence review | f2906a7 |
| 2b | Recovery storage owner with captured root/current guard | complete | 67 targeted tests; 1,006 canonical tests/type/docs/build; native platform/trust; independent AST equivalence | 1fc0397 |
| 2c | Domain IPC registration with centralized trust | complete | 32 targeted tests; identical 95 callbacks/channels and trust gate; 1,031 canonical tests/build; native platform/trust and isolated OpenCode smoke | pending checkpoint |
| 3a | Renderer record/projection/reconciliation ownership and cache | active | state/lifecycle characterization + performance + check | — |
| 4 | Components and styles | pending | component tests + live interaction + check | — |
| 5 | Confirmed consolidation/efficiency | pending | equivalent workloads + check | — |
| 6 | Ownership, permanent architecture enforcement | pending | guardrail adversarial fixtures + docs + check/CI | — |
| 7 | Independent cumulative review/final measurements | pending | full check/platform/runtime/live + review | — |

## Validation plan

Targeted checks follow extracted behavior and its existing tests. Capture baseline and compare identical workloads using the supported Node on this machine. Canonical gate: `npm run check`. Platform gate: `npm run test:platform`; isolated OpenCode, Sass worker, and mirror application checks as affected. Coverage tooling availability and external/live gaps will be reported, not inferred.

## Decisions

- 2026-10-10 — Parallel bounded discovery A/B/C, then D/E/F using available agent slots. No concurrent implementation of coupled files. Distinguish relocation from actual eliminated implementation.
- 2026-10-10 — 30% is a subordinate target; retain necessary behavior rather than manufacture savings. Freeze production scope and commit reproducible inventories.
- 2026-10-10 — Independent reviewer conditionally approved cohesive slices; extraction is relocation, not savings. Reject dropping busy state, auxiliary transcript state, dormant runtime paths, test-only exports, or changing malformed-input semantics.
- 2026-10-10 — Backend: `session-replay.ts` owns pure history projection/todos, importing shared presentation only; SDK calls and authoritative context map remain in `opencode.ts`. Public backend methods stay stable. Shared `tool-presentation.ts` owns equivalent content/path/detail/record normalization; callers retain distinct serialization/title/output policy. Migrate replay test import directly, without permanent compatibility shim. Tests: replay-retention, chat-stream, chat-store, session-retention, runtime-routing.
- 2026-10-10 — Recovery: storage/transaction validation/reconciliation/retention owner accepts captured root and current predicate. Backend keeps workspace identity lookup, security target capture/post-await assertions, mutation ordering and emissions; fsync/error/retention behavior stays identical. Tests: direct-mutation, workspace-security, workspace-target, multi-context; private test harnesses migrate to owner, not wrapper APIs.
- 2026-10-10 — Renderer: first pure transcript reconciliation, then chat projection identity cache keyed by message record plus exact raw parts array. Keep user clone/backfill semantics and authoritative reducer API. Cache does not imply selective React subscription. Tests: chat-store/chat-stream, stream-settle, retention, workspace/panel-swap, forms/permissions, usage/catalog; add invalidation coverage.
- 2026-10-10 — UI: separate Composer completion/model menu/presentation, usage/scroll/menu ownership, Timeline pure tool/delegation/turn transforms and tool presentation, App pure geometry/drag ownership. Preserve markup/keys/cascade and all interaction scenarios. Reject moving entire Composer/Layout into another equally large owner.
- 2026-10-10 — Permanent checks use installed TypeScript AST and frozen baselines, not new architecture tooling dependencies. Fail significant new cycles/layer/private boundary/duplication/size/complexity violations; test adversarial fixtures. Existing CI already calls check; extend that gate and its docs assertion without changing execution policy.

## Baseline evidence

- Supported canonical check passed: 123 files, 989 tests; typecheck, docs and production build passed. Log `/private/tmp/orbit-architecture-baseline-check.log`.
- macOS platform baseline passed after running native GUI checks outside sandbox: launcher/terminal tests, direct and Electron PTY, hidden renderer trust smoke with trusted IPC, denied navigation/popups and untrusted IPC rejection. Log `/private/tmp/orbit-architecture-baseline-platform.log`.
- Existing deterministic large-session workload: 2,400 events/400 turns/800 DOM rows, 13,107,200 retained output chars; median reducer 9.04 ms, derivation 0.24 ms, React/jsdom construction 558.14 ms. One independent run; further identical samples needed before conclusions.
- Tail-delta projection workload: 400 assistants with 32 KiB tool output, 2,400 setup events, 500 deltas, 3 warmups/9 samples. Baseline projection median 240.375 ms (236.637–253.834), zero historical identity reuse. Temporary reproduction `/private/tmp/orbit-projection-benchmark.mjs`; baseline bundle/JSON retained. Excludes Store/React/IPC/layout.
- Frozen production baseline: 38,430 LOC, 152 files, 11 modules >800 LOC, 37 functions >100 LOC, 54 complexity/nesting hotspots. Target 26,901 LOC (11,529 net reduction). Zero runtime SCCs; one explicit type-only markdown cycle. Exact duplication detector initially zero at substantial whole-function/block threshold; audited helper duplication tracked separately. Build 50,276,995 bytes / 720 files.
- Audit responsibility maps and dependency-aware sequencing: `reports/architecture-optimization/audit.md`.
- Metrics inventory/methodology owner: `scripts/architecture-analysis.mjs`, frozen report `reports/architecture-optimization/baseline.json` (independently verified inventory hashes and sum). Exclude tests/fixtures and pinned vendored OpenCode SCSS, retain adapted handwritten implementations; no production scope changes permitted.
- Coverage percentage is not configured; existing behavioral tests cover named invariants, not all native/live surfaces. No coverage percentage claimed.

## Open risks / blockers

- Broad renderer context and coupled generation refs make subscription/state rewrites high risk; prefer characterization and cohesive pure boundaries first.
- Pure extraction does not retire central orchestration by itself. Remaining ownership must be investigated and decomposed or explicitly justified before acceptance.
- Independent review identified user backfill mutation risk and part-only invalidation; preserve cloning and key caches on both record/parts identities.

## Completion

- [ ] Acceptance criteria satisfied or explicitly justified reduction shortfall
- [ ] Integration validation and independent review complete
- [ ] Durable facts updated in canonical owners
- [ ] Future opportunities in normal backlog
- [ ] Final Git state reviewed; remove this temporary file in completion checkpoint

## Latest integration verification

- 2026-10-11 — Combined IPC/renderer working tree passed supported canonical gate: 128 files / 1,031 tests, typecheck, docs, production build. Isolated OpenCode discovery/create/read/delete/SSE smoke passed without model prompts. Native platform/renderer trust gate passed. Renderer paired projection medians 234.893 → 7.030 ms; repeat 241.050 → 7.136 ms, identical content/500 deltas. Scope is projection only.
