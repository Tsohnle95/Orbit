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
| 0 | Baseline and characterization | complete | frozen metrics/hash inventory; supported check/platform; reproducible benchmark | c0950fa |
| 1 | Responsibility maps and reviewed extraction design | complete | Agent F adversarial review; resolutions below | — |
| 2a | Pure session replay and identical shared presentation normalization | complete | 73 targeted tests; 993 full tests/type/docs/build; independent AST equivalence review | f2906a7 |
| 2b | Recovery storage owner with captured root/current guard | complete | 67 targeted tests; 1,006 canonical tests/type/docs/build; native platform/trust; independent AST equivalence | 1fc0397 |
| 2c | Domain IPC registration with centralized trust | complete | 32 targeted tests; identical 95 callbacks/channels and trust gate; 1,031 canonical tests/build; native platform/trust and isolated OpenCode smoke | 2029e83 |
| 3a | Renderer record/projection/reconciliation ownership and cache | complete | 149 targeted tests; 1,031 full tests/type/docs/build; independent equivalence/invalidation review; paired projection benchmark | 0cee93e |
| 4a | AgentPanel/composer/usage/menu/scroll owners and App geometry/interactions | complete | 1,042 canonical tests/type/docs/architecture/build; independent110tests/ASTreview; native mock-IPC fixture: menus/usage/stream/GUI-TUI/theme/Settings/layout | 341129f |
| 4b | Timeline models and presenters | complete | 95 targeted tests; independent review; exact fixture hashes; paired descriptor benchmark; 1,092 canonical tests/type/docs/fitness/build | 22eed79 |
| 4c | Styling ownership and confirmed stale rules | complete | 2,012 surviving selector/declaration occurrences and non-grouped order identical; independent review; 1,092 canonical tests/type/docs/fitness/build | 22eed79 |
| 5a | Credentials and shared session presentation | complete | 72 targeted tests, read-order/failure-path characterization; 26 net LOC; independent review; 1,092 canonical tests/type/docs/fitness/build, repeated after 66-package prune | d8892e3 |
| 5b | Confirmed dead exports/dependencies and markdown type cycle | complete | 34 markdown tests; 66 unused packages removed, no retained version changes; independent review; 1,092 canonical tests/type/docs/fitness/build | 22eed79 |
| 6a | Permanent architecture enforcement and reproducible baseline | complete | 28 adversarial/parser tests; unchanged38,430 baseline; canonical/CI wiring; independentdownward-ratchet review | c0950fa |
| 2d | Filesystem observation owner | complete | 105 targeted native tests; 1094 staged-checkpoint tests/type/docs/fitness/build; platform with native close/reopen and rename/move; exact moved-method independent review | 8970569 |
| 3b | Bookmark, panel projection and renderer contract owners | complete | 138 targeted tests; 1103 staged-checkpoint tests/type/docs/fitness/build; independent hydration/dependency review | 865c1aa |
| 2e | DevTools lifecycle owner | complete | 21 targeted tests; 1111 staged canonical tests/type/docs/fitness/build; independent AST review; native picker/Escape/F12/close-reopen and compiled source denial | 8e0c108 |
| 4d | Recursive Explorer presentation owner | complete | 51 targeted tests; 1111 staged canonical tests/type/docs/fitness/build; independent AST review; native menu/open/rename cancellation; native drag unverified | 545a170 |
| 2g | Release update window owner | complete | 19 targeted tests; isolated canonical gate; independent AST/failure review; signed install unverified | 0bc986a |
| 3c | Workspace editor state and persistence owner | complete | 147 targeted tests; repeated87focused tests; independent callback/ref/cancellation review; isolated canonical gate | 17a5b72 |
| 2f | Workspace mutation workflow owner | complete | 111 native targeted tests; identical11method bodies and repeated durable-workflow benchmark; isolated canonical gate; independent review | 840bc7a |
| 3d | Session catalog and selection state owner | complete | 152 targeted tests; exact4action initializer ASTs; isolated canonical gate; no new effect/subscription | 8a42e53 |
| 5c | Confirmed SDK type and retained parser consolidation | complete | 61 targeted tests; exactparser bodies/session-reopen JS; no cycles/side effects; 26net production LOC; isolated canonical gate | dd78940 |
| 4e | Verified duplicate style declarations | complete | 14production LOC; 2012declarationvectors and2090remainingoccurrences identical; specificity proof; isolated canonical gate | 0db849e |
| 3e | Session inventory state owner | complete | 158 targeted and 56 independent tests; isolated 1153-test canonical gate; native recent reopen/open-context list/polling; no new effect | 3e63792 |
| 6c | Fail-closed architecture configuration, dependency syntax and canonical new-owner routing | complete | 39 targeted tests; independent adversarial probes; isolated 1164-test canonical gate | e825227 |
| 5d | OpenAI account-claim decoding consolidation | complete | 47 focused tests; independent historical 27/current 47 tests; isolated 1186-test canonical gate; 9 net production LOC removed | pending commit |
| 6b | Final ownership consistency/ratchet | pending | docs/check + independentreview | — |
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

- 2026-10-11 — Native disposable QA used actual production renderer/preload with mock IPC/session data: folder/editor opening, model favorites/filter, menu Escape/outside dismissal, session/provider usage, draft clearing, streamed response, GUI/TUI mounting, light/dark theme, Settings tab preservation and Agent Mode enter/exit. This does not verify real provider prompting or full native TUI execution; existing platform PTY and isolated OpenCode smoke cover narrower boundaries. GUI/TUI reader position reset is independently proven pre-existing (600→0 in both historical and current25-turn tests), recorded in follow-ups, and not fixed. Parser JSDoc correction did not change the frozen baseline count.

- 2026-10-11 — UI ownership checkpoint341129f followed by permanent-fitness checkpoint; gate1042tests, actual168modulefitnesscheck, boundedexceptions/downwardratchet, nativeplatformtrustpassed. CurrentprimaryLOC38,480 (+50vsbaseline),8modulesover800 (11baseline),0runtimecycles; extractiondoesnotconstituteLOCsavings. Nextapprovedscopesare pureTimelineextraction (retain formattingfailuresemantics; allocationprototypesrejected), credentialdiscovery/sharednormalization, verifiedstale styles/deadexports andtypecyclecleanup.

- 2026-10-11 — Further owner audits found feasible remaining extractions in Store bookmarks/panel views, backend observation, main DevTools and Explorer tree presentation. Coupling alone does not justify declaring the large Store/backend resolved; these remain implementation work. Linguist lookup data is cohesive and has 1,879 entries without duplicates; retain the readable data and its explicit size budget.

- 2026-10-11 — Native filesystem baseline ran outside the sandbox: 75 watcher/mutation/recovery/multi-context/external-file tests passed with no EMFILE warnings. Both combined canonical gates passed 1,092 tests, including a repeat after physically pruning the66 unused packages. No retained dependency versions changed. Rejected the panel cache prototype: all8 panels changing regressed about18%; retain original projection and pursue cohesive ownership only.

- 2026-10-11 — Credential/session presentation checkpoint d8892e3. Interactive QA became unavailable when the Mac locked; computer-use instructions require a manual unlock. Request is pending while independent source/native filesystem checks continue; no post-cleanup GUI pass claimed.

- 2026-10-11 — User unlocked the Mac; native fixture resumed. Remaining reviewed owner slices: observation, bookmark/panel projection, DevTools and Explorer presenters. These are ownership extractions, not code reduction or performance gains. Observer native105 tests passed; benchmark differences are inconclusive. Canonical integration gates and checkpoints pending.

- 2026-10-11 — Native disposable fixture confirmed DevTools DOM.enable→Overlay.enable→searchForNode, one picked Explorer span selected in Elements via disable→DOM.getBoxModel, Escape cancellation and bottom docking. Frontend F12 closes; reopening reinstalls polling. Compiled CSS bundle source links remain denied. No user app/profile was changed.

- 2026-10-11 — Explorer native fixture verified row opening, root expand/collapse, file-specific context menu and inline rename cancellation. CUA internal drag attempt did not dispatch a move; no native drag success claimed. Existing51 component tests and unchanged presenter ASTs cover routing equivalence; paired historical fixture validation is pending.

- 2026-10-12 — Resumed pending editor/mutation/release-window owners. Fresh independent29 focused owner/updater tests plus87 editor tests are being refreshed; no completion claim. Permanent fitness will record exact moved origins. Editor hook502 inclusive lines contain30 separately checked callbacks; independent composition-only count96. Signed release install remains external/unverified.

- 2026-10-12 — Release controller staged canonical gate passed1118 tests/type/docs/fitness/build. Fresh native platform/trust/PTY/watcher checks passed. Disposable popup QA verified unsaved guard, failure status, main restoration and reload prevention. Native Return action failed; independent Electron37.10.3 old/current probe proves pre-existing data-page/hash and event-slot issues, recorded separately without a behavior fix. Real signed installation remains unverified.

- 2026-10-12 — Editor staged canonical passed1124 tests/type/docs/fitness/build. Native disposable QA loaded the actual renderer/preload and real mutation/recovery/observer owners: opened notes.txt, edited in Monaco, observed unsaved marker/report, saved with original-content expectation and revision1 strong write ID, verified actual disk content and cleared unsaved report, then closed/reopened the saved tab. This does not exercise the production quit/save dialog or real provider prompting.

- 2026-10-12 — Workspace mutation staged gate passed1130 tests/type/docs/fitness/build; native113 tests passed. Two public promise-order tests pass against original8970569, fail with extra async delegate wrappers and pass with direct Promise-typed delegates. Supported bound-call contracts and original queue/rejection ordering preserved; unbound/malformed receivers are unsupported. Final quiet repeated mutation benchmark has equal outcomes and overlapping timings, with currentsource hashes in mutations-comparison.json.

- 2026-10-12 — Selection staged canonical passed1135 tests/type/docs/fitness/build. Native staged renderer/preload fixture verified initial catalog, model switch QAFirstHigh→QASecondAuto, variant QASecondHigh, and Build→Plan while retaining model/variant. IPC logs confirm captured UUID/generation/provider/variant. Mocked catalogs/switch replies are not real-provider integration. Independent actualdiff/4initializer AST/59focusedtest review approved.

- 2026-10-12 — Confirmed consolidation staged canonical passed1147 tests/type/docs/fitness/build. Three parser bodies remain AST-identical and startup-pure; dormant features preserved. Existing shared token type substitutes erased duplicate shapes with unchanged session-reopen JS; one unused static forwarding method removed. Net26 production LOC. Independent1910-line SDK/session-facade exception accepted under frozen single-SDK-owner routing and individually constrained methods.

- 2026-10-12 — Style consolidation staged canonical passed1147 tests/type/docs/fitness/build. Independent Sass/PostCSS reparse confirms2012unique selector/context vectors,2102ordered occurrences, exact2090other-occurrence order, and specificity/mutuallyexclusive-slot proof for all5groups. Source14LOC removed; CSS280bytes smaller, no runtime speed claim. Permanent compact22KB evidence retains source/compiler hashes and reproduction procedure; megabyte temporary vectors excluded from Git.

- 2026-10-12 — Intermediate downward guard ratchet computed from the completed184-module checkpoint only: Store3770→2835 ceiling, retire Index/FileSidebar module exceptions, remove/tighten obsolete function keys62→55, preserve22reviewed moved/composition exceptions, known files174→184. Inventory remains an uncommitted separately reviewed slice; no violation is automatically blessed.

- 2026-10-12 — Intermediate downward ratchet committed as1ecbf38 after independent approval and supported1147-test canonical snapshot gate. Session inventory slice owns two records/current readers and refresh identities, retains effect ordering and failure/stale response semantics;158 targeted tests and independent56 tests passed. Net+31LOC reflects ownership interfaces, not reduction. Canonical/native integration pending.

- 2026-10-12 — Inventory supported isolated canonical gate passed1153tests/type/docs/fitness/build. Native disposable staged renderer/preload displayed recent summary, reopened it and displayed the open-context session; fixture IPC logs confirm continuing active-session polling. Catalog/runtime responses remain mocked. Independent exact4initializer/effect-order/config/docs review approved; new owner meets default budgets.

- 2026-10-12 — Independent fitness probes demonstrated that constant-template/import-equals/computed loaders were omitted, invalid numeric limits could disable comparisons, and unknown modules could lack a named canonical owner. Tooling now represents literal forms, rejects computed loaders, validates the manifest before comparison and derives new-owner routes directly from the existing canonical architecture table. No new ownership documentation system or production behavior change. Original cyclomatic definition remains frozen; assignment-operator limitation is explicit.

- 2026-10-12 — Fitness hardening passed the supported isolated 1164-test canonical gate. Independent frozen-source probe verified all 29 canonical routes and rejected invalid limits, malformed/misspelled selectors, removal of active routes or the entire table, and invalid ratchet attempts. Existing runtime-directory navigation moved into its existing ownership entry cell; routing semantics and numeric ceilings are unchanged.

- 2026-10-12 — Provider account identity now decodes one JWT payload rather than up to three. The account override, direct/nested/root claim precedence, empty and malformed payload behavior, and exact malformed-token TypeError before later provider requests are preserved. Forty-seven focused tests and independent review pass; no concurrency or fallback change and no measured latency claim.

- 2026-10-12 — JWT consolidation isolated canonical gate passed 1186 tests/type/docs/fitness/build. Independent historical public-path suite ran the same 22 identity cases plus original orchestration cases against pristine e825227: all 27 passed, including exact error text and no later HTTP calls. Current focused 47-test suite also passed.
