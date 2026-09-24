# M4 Shared Contract (N1 to N4)

**Status:** N1 and N3 drafted by Junaid (2026-09-23), covering the scoring
side. N2 and N4 drafted by Arundhati (2026-09-23), covering the decision
record and the recording point, adjusted to the file paths N1/N3 corrected
(see below). Junaid reviewed N2/N4 the same day: resolved Arundhati's
N1/N3 gap, settled the `no_healthy_replicas` round's `strategy` field, and
raised one new gap (`DecisionRound.failureReason?`, in N4) that still needs
Arundhati's sign-off before N10/N11 build against it.
**Covers:** the candidate score shape and `score()` method (N1), the decision
record shape (N2), the exclusion-reason taxonomy (N3), and the `POST /route`
decision-recording point (N4).

Landed / to land as:
- N1: `src/routing/types.ts` (`CandidateScore`, `RoutingStrategy.score()`) (Junaid)
- N2: `src/decisions/types.ts` (`Decision`, `DecisionRound`), `src/decisions/decision-log.ts` (Arundhati, N10)
- N3: `src/routing/types.ts` (`ExcludedCandidate`), `src/routing/engine.ts` (Junaid drafts, Arundhati wires per N9)
- N4: `src/routing/engine.ts` (Arundhati, N9), `src/api/server.ts` (Arundhati, N11)

Any change after sign-off goes through a PR that updates this doc and the
affected files together.

---

## N1: Candidate score shape and `score()` method

**File:** `src/routing/types.ts`, not `src/routing/strategies/types.ts` as
`task-split.md` sketched. There is no separate `strategies/types.ts`: the
`RoutingStrategy` contract has lived in `src/routing/types.ts` since M2 (see
its header), and `score()` is a sibling method on the same interface, so it
belongs next to `pick()`, not in a new file. Flagging this here instead of
silently deviating from the task split.

```ts
export interface CandidateScore {
  replicaId: string;
  inFlight: number;
  latencyMs: number | null;
  /** Lower is better, same convention pick() already uses internally. */
  score: number;
  /** Always true: score() only ever emits entries for candidates it actually scored. */
  considered: true;
}

export interface RoutingStrategy {
  readonly name: StrategyName;
  pick(candidates: ReplicaState[], weights: ScoringWeights): string | null;
  /**
   * Score every candidate this strategy actually considered, for capture
   * only. Called by the engine alongside (not instead of) pick(), on the
   * same candidate snapshot within one route() call. Must not mutate
   * strategy state and must not influence what pick() returns.
   */
  score(candidates: ReplicaState[], weights: ScoringWeights): CandidateScore[];
}
```

**Rules:**
- `score()` and `pick()` are called once each, against the same `candidates`
  array, within a single `route()` invocation. No re-read of the registry
  between the two calls: the scored set must match what was actually picked
  from (see "also agreed" below).
- `score()` returns one entry per candidate it actually considered. A
  candidate filtered out before it reached the strategy (unhealthy, or
  already tried) never appears here; it appears in N3's `ExcludedCandidate`
  list instead, attached by the engine.
- `considered: true` is a literal, not a plain `boolean`. Every entry
  `score()` emits is by definition a candidate it considered; there is no
  `considered: false` case, so the type says so instead of leaving a
  meaningless flag to check.
- `score` is unitless per strategy and only meaningful for ranking within one
  strategy's own output, not for comparing across strategies. Lower always
  wins, matching the convention `least-loaded` and `latency-weighted` already
  use internally (lowest in-flight, lowest weighted score).
- Latency-weighted's existing rule carries over: a candidate with
  `latencyMs: null` is excluded from scoring entirely (per its module
  comment), so it does not appear in `score()`'s output for that strategy
  either. It is not an `ExcludedCandidate` (it wasn't filtered by the engine,
  the strategy itself can't rank it), and it is not silently dropped: N8's
  test suite asserts this case explicitly so it stays a documented strategy
  behaviour, not a gap.

  **Arundhati's flag, reviewing this against N3 below:** this creates a real
  gap in N3's "every replica appears somewhere" invariant. A candidate
  latency-weighted declines to score is absent from both `candidates` (N1)
  and `excluded` (N3), it lands nowhere in the `DecisionRound`. N16's
  integration test can't assert universal coverage across all three
  strategies as currently worded if this case is in play. Two ways to close
  it, neither built yet, pick one before N9 is implemented:
  1. Narrow N3's invariant to "every replica the *engine* excludes appears in
     `excluded`," and accept a strategy declining to score a candidate it
     was handed as a separate, pre-existing, out-of-scope behaviour (it isn't
     new in M4, latency-weighted has always ignored null-latency candidates).
     N16 then only asserts full coverage for strategies where it actually
     holds, or runs its coverage assertion under a strategy where every
     healthy, non-excluded candidate has a latency measurement.
  2. Give the engine a way to detect what `score()` dropped (diff its output
     against the candidates it was handed) and represent it as a third
     reason, e.g. `"not_scoreable"`, in `excluded`.
  My preference is (1): (2) makes the engine reach back into a strategy's
  internal scoring choices, which is exactly the coupling the M3 freeze and
  N3's own "engine owns exclusion, strategy owns scoring" boundary are trying
  to avoid. But this is a joint call, not landing until we agree.

  **Junaid's call (2026-09-23):** agreed, going with (1). N3's invariant below
  is narrowed accordingly. N16 asserts full `candidates` + `excluded` coverage
  only under least-loaded and round-robin (neither of which ever declines a
  healthy candidate); it does not assert it for latency-weighted, and a
  separate latency-weighted-specific test (N8) documents the null-latency
  omission directly instead.

**Round-robin's stand-in representation (N6 will implement, agreed here):**
round-robin has no load- or latency-based score. Its `score` is the
candidate's cyclic distance from the cursor: the next candidate to be picked
scores `0`, the one after it `1`, and so on, wrapping. This keeps the "lower
is better" convention uniform across all three strategies (the next pick
always has the lowest score) and gives the decision log a real ranking
instead of `null` or a constant, per N1's requirement in `task-split.md`.
`inFlight` and `latencyMs` are still populated from the candidate's real
runtime state; only `score` is the stand-in.

**Also agreed:**
- `score()` must not read or advance round-robin's cursor. Only `pick()`
  advances it. Calling `score()` any number of times for the same request
  must not change what the next `pick()` returns.
- The engine calls `score()` first, then `pick()`, within the same
  `route()` invocation, so a stateful strategy's `score()` output describes
  the same cursor position that `pick()` is about to act on. N7 (score/pick
  consistency test) checks this holds for round-robin specifically, since
  it's the only strategy where call order could matter.

---

## N2: Decision record shape (`src/decisions/types.ts`)

The structured record every `POST /route` request writes: request id,
timestamp, every round it went through, and which replica (if any) it
ultimately came back from. This is **not** the M3 failover log (that is the
ejection/recovery timeline); it is the substrate M5a's
`explain_routing_decision(request_id)` and `query_decisions(...)` will read.

```ts
// src/decisions/types.ts
export interface DecisionRound {
  /** Every candidate the strategy actually scored this round. Empty if none
   *  survived filtering. May also be missing a candidate the strategy itself
   *  declined to score (see N1's flagged gap above, not yet resolved). */
  candidates: CandidateScore[];
  /** Every replica the engine filtered out before scoring, with why. */
  excluded: ExcludedCandidate[];
  strategy: string;
  /**
   * "picked": the engine returned a replica id this round (whether or not the
   *   request to it then succeeded, see N4).
   * "no_routable_replica": candidates existed (possibly zero after
   *   exclusion) but the engine could not return a pick.
   * "no_healthy_replicas": the registry had no healthy replica at all.
   */
  outcome: "picked" | "no_routable_replica" | "no_healthy_replicas";
  /** Present only when outcome === "picked". */
  pickedReplicaId?: string;
}

export interface Decision {
  /** Unique id, crypto.randomUUID(). Distinct from requestId: one Decision
   *  per request, but the id is its own so a future re-record (never planned,
   *  but not ruled out) wouldn't collide with the request id. */
  id: string;
  requestId: string;
  /** ISO 8601, stamped when the Decision is recorded (request resolution),
   *  not when the first round started. */
  at: string;
  /** In attempt order: index 0 is the first engine call this request made. */
  rounds: DecisionRound[];
  /** The replica the client's response actually came from, or null if the
   *  request ended in any kind of failure. See N4 for exactly which paths
   *  set this to null. */
  chosenReplicaId: string | null;
}

export interface DecisionLog {
  record(decision: Decision): void;
  /** Decisions with from <= at <= to, both bounds optional and inclusive,
   *  ascending by `at`. */
  query(range: { from?: string; to?: string }): Decision[];
  /** Point lookup for M5a's explain_routing_decision. Undefined if no
   *  Decision was ever recorded for that requestId. */
  get(requestId: string): Decision | undefined;
}
```

**Store (N10, `src/decisions/decision-log.ts`):** in-memory, mirroring
`FailoverLog`'s shape (`src/events/failover-log.ts`). `get()` is a linear scan
over the same backing array `query()` uses; a demo-scale fleet's request
volume doesn't justify an index yet, flagged as a revisit if that stops being
true.

**Why one `Decision` per request, not per round:** PRD §5.5 asks for "the
full candidate set" per routing decision, and a client-facing request is one
decision from the caller's perspective even when it took three engine calls
internally to resolve. Splitting rounds out lets `explain_routing_decision`
show the whole retry story, not just the winning round, without losing the
per-request grouping `query_decisions` will aggregate over.

---

## N3: Exclusion-reason taxonomy

**File:** `src/routing/types.ts` (the type), `src/routing/engine.ts` (who
attaches it).

```ts
export interface ExcludedCandidate {
  replicaId: string;
  reason: "unhealthy" | "already_tried";
}
```

**Rules:**
- The strategy never sees, filters, or produces `ExcludedCandidate` entries.
  The engine is what filters `healthy` down to `healthy minus exclude` before
  calling `score()` / `pick()` (the M3 freeze, `docs/decisions.md`
  2026-09-08), so the engine is the only place that knows which replica was
  dropped and why. Keeping this taxonomy out of the strategy's hands is the
  same boundary M3 already drew for `exclude`, just extended to cover the
  observability path too.
- Exactly two reasons for M4, matching the two ways a registered replica can
  fail to reach `score()`/`pick()`:
  - `unhealthy`: filtered by the engine's existing `healthy` check.
  - `already_tried`: filtered by the engine's existing `exclude` check
    (a replica this same request already attempted in an earlier retry
    round, per M3's retry loop).
- A replica that is both unhealthy and already tried (ejected mid-retry after
  an earlier round tried it) reports `unhealthy`: it is the more specific,
  more current reason, and the engine checks `healthy` before `exclude` when
  building the filtered candidate set, so `unhealthy` is also just whichever
  check runs first. No replica gets two entries in the same round.
- Every replica the registry knows about appears somewhere in a
  `DecisionRound` (N2): either in `candidates` (scored) or in `excluded`
  (with a reason). None are silently dropped. This is the property N16's
  integration test checks end to end.

  **Arundhati's flag:** this last bullet is the invariant N1's latency-weighted
  gap breaks (see above). Needs a joint call before N9/N16 are built: either
  narrow this bullet to cover only engine-level filtering, or add a third
  reason so the invariant stays literally true. Not resolving this silently
  either way.

  **Junaid's call (2026-09-23):** narrowed. The invariant is: every replica
  the *engine* excludes (unhealthy, or already tried) appears in `excluded`.
  A candidate a strategy itself declines to score (latency-weighted's
  null-latency case, pre-existing since M2) is not covered by this invariant
  and is not an `ExcludedCandidate`; it is simply absent from the round,
  which is documented strategy behaviour, not an engine bug. See N1's
  resolution above.

---

## N4: `POST /route` decision-recording point (`src/routing/engine.ts`, `src/api/server.ts`)

Purely additive on top of the M3 retry loop (L4): no change to retry
behaviour, response bodies, or error handling. Two things are added: the
engine reports what it saw each call, and the API layer accumulates that into
one `Decision` per request.

**Engine side (N9), every `route()` call, success or failure alike, now also
returns:**
```ts
{
  candidates: CandidateScore[];
  excluded: ExcludedCandidate[];
  strategy: string;
}
```
alongside the existing `RouteResult`. `strategy` is `deps.config.getStrategyName()`
read directly, not the name of a strategy instance that was actually invoked:
on `no_healthy_replicas`, the engine returns before it would otherwise build
or look up a strategy at all (see `engine.ts`'s current early return), so
`strategy` there names the configured strategy, not one that scored anything
this round. **Junaid's flag (2026-09-23):** the original draft didn't say
where `strategy` comes from in that case; settled here so N9 doesn't have to
guess, and so a `no_healthy_replicas` round's `strategy` field isn't read as
"this strategy tried and failed."

The filtering that produces this is:
1. Replicas in the full registry snapshot not in `healthy` -> `excluded` with
   `reason: "unhealthy"`. Never passed to `score()` or `pick()`.
2. Of the remaining (`healthy`), any in `opts.exclude` -> `excluded` with
   `reason: "already_tried"`. Also never scored.
3. Everything left is the round's actual candidate pool: `score()` is always
   called on it (even when empty, returning `[]`), per N1's agreed call
   order (`score()` before `pick()`, same snapshot, no re-read in between).
4. If that pool is empty: `no_healthy_replicas` if `healthy` itself was empty
   (nothing to exclude even before step 2), otherwise `no_routable_replica`
   (everything healthy was excluded by the retry loop). Distinguishes "the
   fleet is down" from "we've tried everyone routable," matching the existing
   M2/M3 distinction those two error codes already carry.
5. If the pool is non-empty, `pick()` is called on it. `null` back means
   `no_routable_replica` with a **non-empty** `candidates` list, this is the
   pre-existing M2 cold-start case (e.g. latency-weighted with no candidate
   that has a latency measurement yet) where candidates were genuinely
   scored but none was pickable. A real replica id back means `picked`.

**API side (N11), in `handleRoute`:**
1. Each loop iteration builds one `DecisionRound` from the engine's
   `RouteResult` plus the outcome logic above, and pushes it onto a
   `rounds: DecisionRound[]` array local to the request (parallel to the
   existing `attempts` accumulator).
2. Exactly once, when the request resolves, whichever way, first-attempt
   `503 no_healthy_replicas`/`no_routable_replica`, mid-loop `502
   replica_request_failed`, exhausted-retries `503 all_replicas_failed`, or a
   `200` success, call `decisionLog.record({ id, requestId, at, rounds,
   chosenReplicaId })`.
3. `chosenReplicaId` is the replica id **only on a `200`**: the replica whose
   response the client actually got back. It is `null` for every failure
   path, including `502 replica_request_failed`, even though that round's
   `pickedReplicaId` is set: the engine did pick a replica, but the client
   never got a usable response from it, so it's not what the PRD means by
   "chosen." Anyone reading the full `Decision` still sees which replica was
   picked and why it failed from `rounds[last].pickedReplicaId` and the
   existing `attempts` list in the HTTP response; `chosenReplicaId` at the
   top level answers "did this succeed, and if so where," nothing finer.
4. `requestId` and `at` reuse the same values the retry loop and response
   body already use; no new id generation.

**Junaid's flag (2026-09-23), real gap:** `DecisionRound` (N2) has no field
for *why* a round with `outcome: "picked"` didn't end up being the answer,
that is, the `ReplicaRequestError.kind`/`status` that caused the retry loop
to move on. That detail only exists in the HTTP response's `attempts` list,
which is never persisted. So `explain_routing_decision(requestId)`, reading
`DecisionLog` alone months later, will see a multi-round `Decision` with two
`picked` rounds and can tell *which* replicas were tried and in what order,
but not *why* the first one didn't work, which undercuts N2's own stated
goal of showing "the whole retry story." Proposing: `DecisionRound` grows an
optional `failureReason?: { kind: ReplicaErrorKind; status?: number }`,
mirroring `RouteAttempt` minus `replicaId` (redundant with
`pickedReplicaId`), set by the API layer in the same place it already builds
`attempts` entries, absent on the round that actually resolved the request.
Small addition, no interface reshuffle, but it changes N2's shape, so it
needs sign-off from both before N10/N11 build against it.

---

## Frozen by this contract

- **`RoutingStrategy.pick()`'s signature, return type, and selection logic.**
  Unchanged from M2/M3. `score()` is additive: read-only, does not mutate
  strategy state, does not influence `pick()`'s outcome. This does not
  reopen the 2026-09-08 frozen-interface decision (`docs/decisions.md`),
  which was specifically about `exclude`-awareness inside `pick()`. See the
  proposed `docs/decisions.md` entry below.
- **The engine, not the strategy, owns exclusion reasons.** Same boundary as
  the M3 `exclude` freeze.
- **The M3 retry loop's control flow, response bodies, and `attempts`
  shape.** N4 only adds a second, parallel accumulator; nothing about when
  the loop retries, ejects, or returns changes.

## Not frozen

- **Whether N3's "every replica appears somewhere" invariant holds for
  strategy-level scoring gaps** (the latency-weighted null-latency case).
  Flagged above, not resolved.
- **`DecisionLog` is in-memory and unbounded**, same deferral as M3's
  failover log. Persistence (PRD §7: JSON lines -> SQLite) waits for M7/M8.
- **`RouteResult`'s shape** grows again the moment M5a needs something from
  it `explain_routing_decision` can't get from the `DecisionLog` alone.

---

## Proposed `docs/decisions.md` entry (pending review)

```
## 2026-09-23: `score()` is additive to the frozen `RoutingStrategy` interface

`RoutingStrategy` grows a second method, `score(candidates, weights):
CandidateScore[]`, called by the engine alongside `pick()` for capture only.

**Why this does not reopen the 2026-09-08 freeze:** that freeze was about
keeping `pick()` ignorant of retry exclusion, specifically refusing to add an
`exclude` parameter to it. `score()` changes neither `pick()`'s signature nor
its selection logic; it is a read-only sibling the engine calls for
observability. The freeze's boundary (the engine filters candidates and owns
exclusion, strategies just score/pick from what they're handed) is unchanged
and, if anything, reinforced by N3 giving the engine exclusion-reason
ownership too.

**Revisit when:** never expected to. If a future strategy needs `score()` to
see anything `pick()` doesn't, that's a new question, not a reopening of
this one.
```

Arundhati's read: agreed, this is the right framing and doesn't reopen the
freeze. Not marking the checklist item done below until the N1/N3 gap above
is also settled, since that gap touches the same interface.

---

## Sign-off checklist

- [x] N1 `CandidateScore` shape, `score()` method, round-robin stand-in
      representation, `score()`/`pick()` call-order agreement (Junaid,
      2026-09-23).
- [x] N3 `ExcludedCandidate` shape, engine-owns-exclusion-reasons, the
      unhealthy-wins-over-already_tried tiebreak (Junaid, 2026-09-23).
- [x] N2 `Decision`/`DecisionRound` shape, `DecisionLog` interface (Arundhati,
      drafted 2026-09-23, pending Junaid review).
- [x] N4 engine outcome/filtering rules and the API layer's recording point,
      including the `chosenReplicaId` null-on-non-retryable-failure rule
      (Arundhati, drafted 2026-09-23, pending Junaid review).
- [x] **The N1/N3 gap:** resolved (Junaid, 2026-09-23). Narrowed to
      engine-level exclusions only; latency-weighted's null-latency omission
      is documented strategy behaviour, not an invariant violation.
- [x] N1/N2 cross-check: `DecisionRound.candidates` type-checks against
      whatever `score()` actually returns (both, 2026-09-23).
- [x] N3/N4 cross-check: the `unhealthy` / `already_tried` filtering order in
      N4 matches N3's taxonomy exactly (both, 2026-09-23).
- [x] `chosenReplicaId` semantics on a non-retryable `502` (null, not the
      picked-but-failed replica id) agreed by both (2026-09-23).
- [x] `strategy` field's source on a `no_healthy_replicas` round (config
      name, not an invoked instance) settled (Junaid, 2026-09-23).
- [ ] **New, needs Arundhati's call:** `DecisionRound.failureReason?`
      (Junaid's proposal above) to close the gap where a retried request's
      earlier rounds lose their failure reason once the HTTP response is
      gone. Changes N2's shape, blocks N10/N11 until agreed.
- [ ] `docs/decisions.md` entry confirmed and committed (both).

Once every box is checked, N5 through N13 build against this doc.
