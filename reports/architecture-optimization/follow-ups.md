# Separately observed opportunities

These are outside this semantics-preserving campaign's implementation scope.
They are not acceptance claims or silently bundled behavior changes.

- **GUI/TUI mode changes lose a reader's mid-history position.** Native QA
  scrolled a 25-turn fixture into the middle, switched GUI → TUI → GUI, and
  returned at the beginning. Independent paired tests loaded the historical
  `AgentPanel` from `0cee93e` and current source: both replaced the scroll DOM,
  changed scrollTop from 600 to 0, and retained all 25 turns. The unchanged
  scroll restoration effect depends on workspace memory identity, while the
  parent component stays mounted during mode changes. A future behavior fix
  should characterize mode transition restoration separately from whole-panel
  remount, bottom-follow, reader intent and incoming streamed content.
- **Broad renderer context remains a propagation cost.** Per-session projection
  reuse reduces derived work but `usePanel` still consumes the broad Store
  context. A selector migration requires render-count characterization across
  unrelated sessions and explicit ownership of optimistic/busy/permission state.
- **Panel projection's inbox dependency needs a separate correctness review.**
  Discovery observed an omitted inbox dependency in the existing memo. It was
  not corrected during extraction.
- **Renderer teardown timer cleanup needs characterization.** Existing tree,
  toast and compaction timers are not uniformly cancelled; stale workspace
  checks mitigate writes but do not establish complete teardown cleanup.
- **Sharing filesystem observation needs workload evidence.** Separate contexts
  intentionally own baselines and watcher lifetime; reducing repeated same-root
  reads requires reference-count/lifecycle measurement before changing ownership.
- **Provider concurrency is not behavior-neutral.** Existing malformed OpenAI
  credentials reject before subsequent provider HTTP calls begin. Parallelization
  would change failure side effects. Keep sequencing unless a separate behavior
  change deliberately defines normalization and continuation policy.

Design experiments, mockups, dormant adapters, public/test-only exports and
prototype plugins remain intentionally preserved without an established
deletion policy. Static unused-consumer findings alone do not authorize removal.
