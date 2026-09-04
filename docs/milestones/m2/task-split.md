# M2 Task Split — Routing Engine

**Authors:** Junaid Pathan, Arundhati Vasishth
**Scope:** M2 only (PRD §5.3): pluggable routing strategies, live-swappable, scoring
healthy replicas on in-flight load + latency, plus the request-serving endpoint
that uses them.
**Goal of this doc:** split M2 into two tracks of comparable weight, cut so each
person can build and test their track without waiting on the other, mirroring the
[M1 task split](../m1/task-split.md).

---

## 1. Principle

M2's natural seam is the same shape as M1's: a pure, side-effect-free piece
(scoring and strategy logic) and a serving/wiring piece (the endpoint that calls
it and returns a response). That seam lets both tracks be built and unit-tested
independently against a shared interface, agreed first.

- **Junaid — Scoring & Strategy track:** the routing algorithm itself. Pure
  functions over a `RegistrySnapshot`, no HTTP, no adapter calls. Continues
  naturally from the M1 replica/health track (owns replica synthetic profiles
  already).
- **Arundhati — Serving & Config track:** the request-serving surface (`POST
  /route`) and live strategy/weight configuration. Continues naturally from the
  M1 registry/service track (owns `src/api/`, `src/config.ts`).

Per the M1 task split's balance note, this pairing keeps to the plan there: M2 is
even between the two of you, with Junaid's extra load-bearing assist landing
later at M5b and M6.

---

## 2. Shared contract (design together first, ~30 min, before any code)

Agree on and commit these before splitting off:

| Item | File | Notes |
|---|---|---|
| **K1** Strategy interface | `src/routing/types.ts` | `RoutingStrategy.pick(candidates: ReplicaState[], weights: ScoringWeights): string \| null` — returns a replica id or `null` if no healthy candidate. `ScoringWeights = { loadWeight, latencyWeight }`. |
| **K2** Routing engine interface | `src/routing/engine.ts` (signature only) | `RoutingEngine.route(): { replicaId: string } \| { error: "no_healthy_replicas" }` — reads the registry snapshot, filters to `healthy`, delegates to the active strategy. |

Also agree on: the `POST /route` request/response JSON shape, and how strategy
and weights are held (single mutable in-process config object, read by the
engine on every call, no restart needed to swap).

---

## 3. Junaid — Scoring & Strategy track

| # | Task | Deliverable |
|---|---|---|
| K3 | **Round-robin strategy** | `src/routing/strategies/round-robin.ts` — cycles healthy candidates in registration order, ignoring load/latency. |
| K4 | **Least-loaded strategy** | `src/routing/strategies/least-loaded.ts` — picks lowest `inFlight`; ties broken deterministically (e.g. replica id order). |
| K5 | **Latency-weighted strategy** | `src/routing/strategies/latency-weighted.ts` — scores by `loadWeight * inFlight + latencyWeight * latencyMs`, picks lowest score; replicas with `latencyMs: null` (never successfully probed) are excluded from candidates, not scored as 0. |
| K6 | **Strategy registry** | `src/routing/strategies/index.ts` — maps strategy name to implementation, used by both the engine and `set_routing_strategy`-shaped config later (M5b); throws on an unknown name rather than silently defaulting. |
| K7 | **Per-replica synthetic profiles wired through the launcher** | closes the M1 architecture review deferral #3: `src/replica/launch.ts` threads distinct load/latency profiles from config instead of every replica using `DEFAULT_PROFILE`. Needed so K3–K5 have something real to distribute across in testing. |
| K8 | **Unit tests** | each strategy against hand-built `ReplicaState[]` fixtures: correct pick under even load, under skewed load, with an empty healthy set, with a single candidate, with `latencyMs: null` candidates for K5. |

---

## 4. Arundhati — Serving & Config track

| # | Task | Deliverable |
|---|---|---|
| K9 | **Routing engine implementation** | `src/routing/engine.ts` — implements K2 against a `RegistryStore` (read-only) and the active strategy from config; the one piece that touches both tracks' work, but is authored solo against the already-agreed interfaces from §2. |
| K10 | **Live strategy/weight config** | `src/routing/config.ts` — mutable in-process holder for current strategy name and `ScoringWeights`, defaults from `src/config.ts`; exposes a getter/setter pair the engine and (later, M5b) MCP action tools both use. |
| K11 | **`POST /route` endpoint** | `src/api/server.ts` (extends B4) — calls the routing engine, on success calls `adapter.sendRequest(replicaId, payload)` and returns `{ replicaId, response, latencyMs }`; on `no_healthy_replicas` returns 503 with a clear body. First real caller of `sendRequest`, closing M1 architecture review note that it had none. |
| K12 | **Unit tests** | engine (delegates to correct strategy, handles empty registry); `/route` endpoint (200 path with a stubbed adapter, 503 path with no healthy replicas). |

---

## 5. Joint tasks (kept deliberately small so both tracks run in parallel)

| # | Task | Split |
|---|---|---|
| K13 | **Main wiring** — `src/main.ts`: construct the routing engine and config, pass into the status/route server. Small diff on top of M1's `main.ts`; whoever finishes their track first drafts it, the other reviews. | either drafts, other reviews |
| K14 | **Integration test** — `test/integration/m2.test.ts`: boot fleet + main, send `POST /route` under each strategy, assert routing follows the expected pattern (round-robin cycles, least-loaded picks the emptiest replica), kill a replica mid-run and assert it drops out of candidates. | pair |
| K15 | **M2 architecture review + README update** | both, same shape as [`docs/architecture/m1.md`](../../architecture/m1.md): confirm no failover/decision-log/MCP assumptions leaked in (those are M3+), sign off. |

Everything else — K3–K8 and K9–K12 — is single-owner. Neither person needs to
wait on the other except for K9 (which only needs §2's interfaces, not K3–K8's
finished implementations) and K13/K14 at the very end.

---

## 6. Sequencing

1. **Day 1:** K1 + K2 shared contract (together, ~30 min).
2. **Day 1–2:** Junaid K3–K5 (strategies), Arundhati K9–K11 (engine, config,
   endpoint) in parallel. Both only depend on §2, not on each other.
3. **Day 2–3:** Junaid K6–K7, Arundhati continues/finishes K11. Junaid K8 tests,
   Arundhati K12 tests. Still independent.
4. **Day 3:** K13 wiring (whoever's free first drafts, other reviews same day).
5. **Day 4:** K14 integration test (pair).
6. **Day 4–5:** K15 review, sign-off.

Only hard dependency: K9 (engine) needs K1/K2 agreed, not K3-K5 built (it can be
written against the strategy interface and a stub strategy, then swapped to the
real strategy registry K6 once ready). This is what lets both tracks run fully
parallel through most of the week.

---

## 7. Effort balance check

| | Junaid | Arundhati |
|---|---|---|
| Shared design authoring | K1 strategy interface | K2 engine interface |
| Large module | three strategies (K3–K5) | engine + live config (K9–K10) |
| Medium module | strategy registry (K6) | `POST /route` endpoint (K11) |
| Small module | per-replica profiles (K7) | — (endpoint is the comparable weight) |
| Tests | own modules (K8) | own modules (K12) |
| Joint | K13 wiring, K14 integration test, K15 review, split evenly | same |

Each side: one interface authored, comparable module weight (three focused
strategies vs. engine + config + endpoint), own unit tests, half of every joint
task. Three joint tasks total (down from four in M1), and two of those three
(K13, K14) are short by design so neither person is blocked waiting on the other
for most of the milestone.

---

## 8. Definition of done (M2)

- `POST /route` picks a replica under all three strategies (round-robin,
  least-loaded, latency-weighted) and forwards the request via `sendRequest`.
- Strategy and scoring weights are swappable without restarting the process
  (config setter, no MCP tool yet, that's M5b).
- Killing a replica mid-traffic removes it from candidates on the next health
  transition, with no routing-layer code changes needed (adapter boundary from
  M1 holds).
- No replica exceeds 1.5x median utilization under least-loaded with even
  synthetic load, per PRD §8 success metric (validated in K14 or a follow-up
  load test).
- Unit + integration tests green in CI.
- Both authors have signed off in M2's architecture review (K15).
