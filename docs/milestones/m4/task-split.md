# M4 Task Split: Decision Log

**Authors:** Arundhati Vasishth, Junaid Pathan
**Scope:** M4 only (PRD §5.5, §9): every routing decision writes a structured
record: request ID, timestamp, chosen replica, the full candidate set with
each one's score inputs at decision time, and the reason for any exclusion.
This is the substrate every M5a read tool (`explain_routing_decision`,
`query_decisions`) will query. It is **not** the M3 failover log (that is the
ejection/recovery timeline); this is per-request routing rationale.
**Goal of this doc:** split M4 into two tracks of comparable weight, cut so
each person can build and test their track against a shared interface agreed
first, mirroring the [M1](../m1/task-split.md), [M2](../m2/task-split.md), and
[M3](../m3/task-split.md) splits.

---

## 1. Principle

M3 answered "what happens when a pick fails." M4 answers "why was this pick
made at all," for every pick, not just the failed ones. The natural seam is
the same shape as M2 and M3: a scoring piece (what did every candidate look
like at decision time, not just the winner) and a serving/storage piece (turn
that into a queryable record per request).

- **Junaid, Candidate Scoring & Capture track:** exposing the score inputs
  every strategy already computes internally, for every candidate it
  considered, not just the one it picked. Continues from the M1/M2 Scoring &
  Strategy track and M3's Detection & Ejection track (owns
  `src/routing/strategies/`).
- **Arundhati, Decision Log track:** the decision record shape, the log
  store, and wiring it into `POST /route`'s retry loop. Continues from the
  M2/M3 Serving & Retry & Events track (owns `src/api/`,
  `src/routing/engine.ts`, `src/decisions/`).

Per the M1/M3 balance notes, M4 stays even between the two of you.

### The one hard design question

`RoutingStrategy.pick(candidates, weights)` returns only the winner's replica
id; everything it computed for the candidates it didn't pick is thrown away.
M3 froze this interface deliberately (`docs/decisions.md`, 2026-09-08) so
strategies stay ignorant of retry exclusion. M4 needs the opposite of what M3
needed from that interface: not a *change* to how a strategy decides, but
*visibility* into what it already decided for every candidate.

The leading answer: add a sibling method, `score(candidates, weights):
CandidateScore[]`, that every strategy also implements, called by the engine
purely for capture, right alongside `pick()`. `pick()`'s selection logic does
not change, is not called differently, and does not gain a new parameter, so
the M3 freeze holds: this is additive, not a reopening of that decision.
Settling exactly how `score()`'s output lines up with `pick()`'s winner (same
call, or a second call risking drift if a strategy is stateful like
round-robin's cursor) is the first job of the shared contract. Confirm in
`docs/decisions.md` that this does not reopen the M3 freeze, since the freeze
was specifically about `exclude`-awareness inside `pick`, not about adding an
observability-only sibling method.

---

## 2. Shared contract (design together first, ~45 min, before any code)

Agree on and commit these before splitting off. Junaid drafts N1 and N3,
Arundhati drafts N2 and N4, both review the whole thing.

| Item | File | Notes |
|---|---|---|
| **N1** Candidate score shape + `score()` method | `src/routing/strategies/types.ts` | `CandidateScore = { replicaId; inFlight; latencyMs: number \| null; score: number; considered: true }` for every candidate the strategy actually scored. `RoutingStrategy` grows `score(candidates, weights): CandidateScore[]`, called by the engine alongside (not instead of) `pick()`. Round-robin has no numeric score in the least-loaded/latency-weighted sense; agree on its stand-in representation (e.g. `score` = candidate's distance from the cursor) rather than leaving it `null` and creating a gap in the decision record. |
| **N2** Decision record shape | `src/decisions/types.ts` | `Decision = { id; requestId; at: string; rounds: DecisionRound[]; chosenReplicaId: string \| null }`. `DecisionRound = { candidates: CandidateScore[]; excluded: ExcludedCandidate[]; strategy: string; outcome: "picked" \| "no_routable_replica" \| "no_healthy_replicas"; pickedReplicaId?: string }`. One `Decision` per client-facing `POST /route` request (spanning every retry round), not one per attempt, id'd by the same `requestId` `handleRoute` already generates. Store exposes `record(decision)`, `query({ from?, to? }): Decision[]`, and `get(requestId): Decision \| undefined` in time order. |
| **N3** Exclusion-reason taxonomy | `src/routing/strategies/types.ts` (+ `engine.ts`) | `ExcludedCandidate = { replicaId; reason: "unhealthy" \| "already_tried" }`. A replica that never reached the strategy (filtered out by the engine before `score()` is called) still needs to appear in the round's `excluded` list with a reason, it must not silently vanish from the record. The engine is what filters `healthy` and `exclude`, so it is what attaches these reasons, not the strategy. |
| **N4** `POST /route` decision-recording point | `src/api/server.ts` | The retry loop already tracks `attempts` per request; N4 defines how each retry round's engine call (N9) turns into one `DecisionRound`, and how the whole `Decision` gets recorded exactly once, when the request resolves (success or `503 all_replicas_failed`), not once per round. |

Also agree: whether `score()` is called on the same snapshot `pick()` used
(no re-read of the registry between the two calls within one `route()`
invocation, to avoid the scored set drifting from what was actually picked),
and the default retention behaviour for the decision log (see N12).

### Frozen by this contract (do not change in M4)

`RoutingStrategy.pick(candidates, weights)`'s signature, return type, and
selection logic do not change. `score()` is additive and read-only: it must
not mutate strategy state (round-robin's cursor in particular) and must not
influence which replica `pick()` returns. Record in `docs/decisions.md` that
this is additive to, not a reopening of, the 2026-09-08 frozen-interface
decision.

---

## 3. Junaid: Candidate Scoring & Capture track

| # | Task | Deliverable |
|---|---|---|
| N5 | **Strategy `score()` method** | `src/routing/strategies/`: implement `score(candidates, weights): CandidateScore[]` per N1 for round-robin, least-loaded, and latency-weighted. Must not alter `pick()`'s behaviour; existing M2/M3 strategy tests stay green unmodified. |
| N6 | **Round-robin score representation** | Round-robin has no weighted score. Implement and document the N1 stand-in (cursor-distance or equivalent) so the decision log has a real value, not a gap, for the default-adjacent strategy. |
| N7 | **Score/pick consistency** | Confirm `score()` and `pick()` agree: the candidate `score()` ranks highest (or the next in rotation, for round-robin) is always the same replica `pick()` actually returns for the same candidate set and weights. Add a property-style test that fails if they ever diverge. |
| N8 | **Unit tests** | `score()` correctness per strategy (weights reflected in the score, only actually-considered candidates appear, never an unhealthy or excluded replica); round-robin's stand-in representation; N7's consistency check; regression run confirming `pick()`'s existing test suite is unaffected by adding `score()`. |

---

## 4. Arundhati: Decision Log track

| # | Task | Deliverable |
|---|---|---|
| N9 | **Engine plumbing for full candidate capture** | `src/routing/engine.ts`: `route()` calls the active strategy's `score()` alongside `pick()` on the same candidate snapshot (per the shared contract), and `RouteResult`'s success case grows a `round: DecisionRound`-shaped payload per N1/N3, with the engine (not the strategy) attaching `ExcludedCandidate` reasons for replicas filtered out before scoring (unhealthy, or in `opts.exclude`). |
| N10 | **Decision record & log store** | `src/decisions/types.ts` (`Decision`, `DecisionRound`, per N2) and `src/decisions/decision-log.ts`: in-memory store mirroring `FailoverLog`'s shape (`src/events/failover-log.ts`): `record()`, `query({ from?, to? })`, plus `get(requestId)` for M5a's future point lookup. |
| N11 | **Wiring into `POST /route`'s retry loop** | `src/api/server.ts`: `handleRoute` accumulates one `DecisionRound` per engine call (each retry attempt) using its existing `requestId`, and records exactly one `Decision` when the request resolves, success or `all_replicas_failed`, per N4. Mirrors how `attempts` is already accumulated, so this is additive to the existing loop, not a rewrite of it. |
| N12 | **Decision log retention note** | In-memory and unbounded for M4, same deferral shape as M3's failover log (`src/events/failover-log.ts` header). Document the deferral in `src/decisions/decision-log.ts`'s own header rather than building a retention cap now; persistence (PRD §7: JSON lines → SQLite) is an M7/M8 concern once Docker/K8s exist to manage it. |
| N13 | **Unit tests** | Decision log `record`/`query`/`get` (range filtering, ascending order, point lookup by `requestId`); route-endpoint tests asserting a `Decision` is recorded with the correct `chosenReplicaId` and a full candidate set (including excluded reasons) on a first-try success; a multi-round retry case asserting every round is captured, in order, with the final `chosenReplicaId` correct. |

---

## 5. Joint tasks

| # | Task | Split |
|---|---|---|
| N14 | **Shared contract doc** in `docs/milestones/m4/shared-contract.md`: the N1 through N4 decisions written up the way M2's and M3's were, plus the `docs/decisions.md` entry confirming N1/frozen-contract does not reopen the 2026-09-08 `RoutingStrategy` freeze. | pair, Junaid drafts N1/N3, Arundhati drafts N2/N4 |
| N15 | **Main wiring** in `src/main.ts`: construct the decision log, wire it into the API server deps alongside the existing failover log / scheduler wiring. Small diff on top of M3's `main.ts`. | whoever finishes their track first drafts, other reviews |
| N16 | **Decision-log integration test** in `test/integration/m4.test.ts`: boot fleet + main, drive `POST /route` load, kill one replica mid-run (reusing M3's pattern) so at least one request takes a retry round, then assert: every request produced exactly one `Decision`; each round's candidate set includes every healthy, non-excluded replica with a real score; the killed replica appears in the retried request's `excluded` list with `reason: "already_tried"` on its retry round; and `chosenReplicaId` matches what the client actually got back. | pair |
| N17 | **M4 architecture review + README update** in `docs/architecture/m4.md`, same shape as [`m3.md`](../../architecture/m3.md): confirm no MCP / dashboard / natural-language-query concerns leaked in (M5 / M6), confirm `RoutingStrategy.pick()`'s contract is unchanged and `score()` is genuinely additive, report the decision log's shape and query surface as the groundwork for M5a's `explain_routing_decision` and `query_decisions`, both sign off. Update the README with the decision log's behaviour. | both |

Everything else, N5 through N8 and N9 through N13, is single-owner. The only
cross-track dependency is N9 (needs N5's `score()` and N7's consistency
guarantee) and N15 / N16 at the end.

---

## 6. Sequencing

1. **Day 1:** N14 shared contract (together, ~45 min); settle N1's `score()`
   design and the round-robin stand-in before any code.
2. **Day 1-2:** Junaid N5 (`score()` per strategy), Arundhati N9 (engine
   plumbing) in parallel. Both only depend on §2.
3. **Day 2-3:** Junaid N6-N7, Arundhati N10-N11. Arundhati's N11 works against
   N9's shape once it lands; N9 can itself start against a stubbed `score()`
   until N5 merges.
4. **Day 3-4:** Junaid N8 tests, Arundhati N12-N13 tests. Still independent.
5. **Day 4:** N15 wiring (whoever is free first drafts, other reviews same
   day).
6. **Day 4-5:** N16 decision-log integration test (pair).
7. **Day 5:** N17 review and sign-off.

Only hard dependency: N9 needs N1 agreed (not N5 built, it can be written
against the interface and a stub first). This is what lets both tracks run
parallel through most of the week, same pattern as M3.

---

## 7. Effort balance check

| | Junaid | Arundhati |
|---|---|---|
| Shared design authoring | N1 score shape + N3 exclusion taxonomy | N2 decision record + N4 recording point |
| Large module | `score()` across all three strategies + consistency check (N5, N7) | engine plumbing + retry-loop wiring (N9, N11) |
| Medium module | round-robin stand-in (N6) | decision log store (N10) |
| Small module | (none) | retention deferral note (N12) |
| Tests | own module (N8) | own modules (N13) |
| Joint | N14-N17, split evenly | same |

Each side: half the shared contract authored, comparable module weight
(scoring exposure vs. capture/storage plumbing), own unit tests, half of
every joint task.

---

## 8. Working agreement

The commit / branch / PR / review rules live in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
at the repo root. They are project-wide, not M4-specific. In force for all of M4.

---

## 9. Definition of done (M4)

- Every `POST /route` request produces exactly one `Decision`, id'd by its
  `requestId`, capturing every round the request went through.
- Each round's candidate set includes every candidate the strategy actually
  scored, with its score inputs at decision time, not just the winner.
- A replica excluded before scoring (unhealthy, or already tried earlier in
  the same request) appears in the round's exclusion list with a reason,
  never silently omitted.
- `RoutingStrategy.pick()`'s existing signature and selection behaviour are
  unchanged; `score()` is additive and verified not to influence `pick()`'s
  outcome (N7).
- The decision log is queryable by time range and by `requestId` (`get`),
  the groundwork M5a's `explain_routing_decision` and `query_decisions` will
  build on.
- A retried request's decision captures every round, not only the final
  successful or failed one (validated in N16).
- Unit + integration tests green in CI.
- Both authors have signed off in M4's architecture review (N17).
