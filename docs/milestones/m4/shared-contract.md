# M4 Shared Contract (N1 to N4)

**Status:** N1 and N3 drafted by Junaid (2026-09-23), covering the scoring
side of the contract. N2 and N4 (the decision record shape and the
`POST /route` recording point) are Arundhati's to draft, same split as
`task-split.md` section 2. Both review the whole thing before either track
starts building against it.
**Covers:** the candidate score shape and `score()` method (N1), the
exclusion-reason taxonomy (N3). N2 and N4 land here once drafted.

Landed / to land as:
- N1: `src/routing/types.ts` (`CandidateScore`, `RoutingStrategy.score`)
- N3: `src/routing/types.ts` (`ExcludedCandidate`), `src/routing/engine.ts`
- N2: `src/decisions/types.ts` (Arundhati, pending)
- N4: `src/api/server.ts` (Arundhati, pending)

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
  from (see "also agree" below).
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

---

## Frozen by this contract

- **`RoutingStrategy.pick()`'s signature, return type, and selection logic.**
  Unchanged from M2/M3. `score()` is additive: read-only, does not mutate
  strategy state, does not influence `pick()`'s outcome. This does not
  reopen the 2026-09-08 frozen-interface decision (`docs/decisions.md`),
  which was specifically about `exclude`-awareness inside `pick()`. A new
  `docs/decisions.md` entry recording this is proposed below, pending
  Arundhati's review alongside N2/N4.
- **The engine, not the strategy, owns exclusion reasons.** Same boundary as
  the M3 `exclude` freeze.

## Not frozen

- N2 (decision record shape) and N4 (recording point) are not drafted yet.
- Whether `score()`'s output is captured on every `route()` call or only
  when a decision log consumer is wired up (N9) is Arundhati's call to make
  as part of N2/N4, since it is a capture-path question, not a strategy
  question.

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

---

## Sign-off checklist

- [x] N1 `CandidateScore` shape, `score()` method, round-robin stand-in
      representation, `score()`/`pick()` call-order agreement (Junaid,
      2026-09-23).
- [x] N3 `ExcludedCandidate` shape, engine-owns-exclusion-reasons, the
      unhealthy-wins-over-already_tried tiebreak (Junaid, 2026-09-23).
- [ ] N2 decision record shape (Arundhati).
- [ ] N4 `POST /route` recording point (Arundhati).
- [ ] Both review the whole doc together.
- [ ] `docs/decisions.md` entry confirmed and committed (both).

Once every box is checked, N5 through N13 build against this doc.
