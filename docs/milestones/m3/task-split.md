# M3 Task Split: Failover & Recovery

**Authors:** Arundhati Vasishth, Junaid Pathan
**Scope:** M3 only (PRD §5.4, §9): when a replica fails a health check or a
request to it errors, drop it from the candidate pool immediately and retry the
request against the next-best replica (up to 2 retries, 3 attempts total).
Recovery is automatic once health checks pass again. Plus the failover event
record every ejection and recovery writes, which M5a's `get_failover_history`
later reads.
**Goal of this doc:** split M3 into two tracks of comparable weight, cut so each
person can build and test their track against a shared interface agreed first,
mirroring the [M1](../m1/task-split.md) and [M2](../m2/task-split.md) splits.

---

## 1. Principle

M2 built a router that always assumes its pick works. M3 is what happens when it
doesn't. The natural seam is the same shape as before: a health / adapter piece
(detecting a bad replica and taking it out of rotation) and a serving piece (the
retry loop in `POST /route` that walks to the next-best replica and the event
log that records what happened).

- **Junaid, Detection & Ejection track:** the adapter error taxonomy and the
  scheduler's fast-eject path. Continues from the M2 scoring / strategy track and
  the M1 replica / health track (owns `src/health/`, `src/adapter/`,
  `src/replica/`).
- **Arundhati, Retry & Events track:** the retry orchestration in `POST /route`,
  the engine's candidate-exclusion support, and the in-memory failover event
  store. Continues from the M2 serving / config track (owns `src/api/`,
  `src/routing/engine.ts`, `src/config.ts`).

Per the M1 balance note, M3 stays even between the two of you; Junaid's
load-bearing assist still lands at M5b and M6.

### The one hard design question

Today the only thing that takes a replica out of rotation is the health
scheduler, and it needs `WR_UNHEALTHY_THRESHOLD` (default 3) consecutive failed
probes at a 1s interval. That is 3s from death to traffic shed, and the PRD §8
target is under 1s. M3's answer is **request-driven ejection**: the moment a live
`POST /route` request to a replica fails with a retryable error, eject that
replica right away instead of waiting for the health loop. The health path stays
as the recovery mechanism and the backstop for a replica that dies with no
traffic flowing through it. Settling exactly how the two paths interact is the
first job of the shared contract.

---

## 2. Shared contract (design together first, ~45 min, before any code)

Agree on and commit these before splitting off. Junaid drafts L1 and L2,
Arundhati drafts L3 and L4, both review the whole thing.

| Item | File | Notes |
|---|---|---|
| **L1** Adapter error taxonomy | `src/adapter/types.ts` (+ `http.ts`) | `sendRequest` rejects with a typed error carrying `{ kind: "timeout" \| "connection" \| "http_status"; status?: number; retryable: boolean }`. Timeout, connection-refused, and 5xx are retryable; 4xx is not. Closes M1 review deferral 2 / M2 review deferral 1. |
| **L2** Ejection & recovery semantics | `src/health/scheduler.ts` | `HealthScheduler.eject(replicaId, reason)`: sets the replica's internal hysteresis state to `unhealthy` now, resets `consecSuccesses`, writes through the sink, emits a `HealthTransition`. Recovery still requires `WR_HEALTHY_THRESHOLD` consecutive clean probes, so a flapping replica cannot rejoin on one lucky probe. The eject signal goes **through the scheduler**, not straight to the registry, because the scheduler owns the hysteresis map. |
| **L3** Failover event record | `src/events/types.ts` | `FailoverEvent = { id; replicaId; kind: "ejected" \| "recovered"; at: string; trigger: "health_check" \| "request_failure"; reason: string; requestId?: string }`. Store exposes `record(event)` and `query({ from?, to? }): FailoverEvent[]` in time order. This is **not** the M4 decision log (that is per-request routing rationale); it is the failover timeline M5a's `get_failover_history(time_range)` queries. Closes M1 review deferral 4. |
| **L4** `POST /route` retry behaviour | `src/api/server.ts` | Up to `WR_MAX_RETRIES` retries (default 2, so 3 attempts). Each attempt asks the engine for a pick excluding every replica already tried this request. A retryable failure ejects the replica (L2), records an event (L3), and continues; a non-retryable failure stops immediately. First success returns `200` with the existing M2 body plus `attempts` (the ordered list of `{ replicaId, error }` for the failed tries, empty on a first-try success). All attempts exhausted returns `503 { error: "all_replicas_failed", attempts: [...] }`. |

Also agree: whether `engine.route()` grows an options argument or a second
method for the exclusion set (see L10), and the default for `WR_MAX_RETRIES`.

### Frozen by this contract (do not change in M3)

The `RoutingStrategy` interface does **not** change. Retry picks the next-best
replica by having the engine filter `healthy` down to `healthy minus alreadyTried`
and then calling `strategy.pick` on the smaller set, exactly as it does today.
Strategies stay ignorant of failover. Record this in `docs/decisions.md`.

---

## 3. Junaid: Detection & Ejection track

| # | Task | Deliverable |
|---|---|---|
| L5 | **Typed adapter errors** | `src/adapter/http.ts` rejects `sendRequest` (and surfaces from `checkHealth` where useful) with the L1 error type: classify `AbortError` as `timeout`, `fetch` throw as `connection`, non-2xx as `http_status` with the code, each tagged `retryable`. Existing "throws a generic Error" callers keep working (the type extends `Error`). |
| L6 | **Scheduler fast-eject + recovery** | `src/health/scheduler.ts`: implement `eject()` per L2. Confirm the recovery path still runs purely off `WR_HEALTHY_THRESHOLD` and that an ejected replica that is genuinely back reaches `healthy` after exactly M clean probes, no faster. Emit the transition so the event store (L12) and the console log both see it. |
| L7 | **Hysteresis tuning + probe-latency measurement** | Measure real `GET /health` round-trip across the fleet under load, then set `WR_UNHEALTHY_THRESHOLD` / `WR_HEALTHY_THRESHOLD` / `WR_HEALTH_INTERVAL_MS` so the health path alone detects a no-traffic death without flapping. Record the numbers and the reasoning in `docs/decisions.md` (supersedes the 2026-09-03 hysteresis entry). |
| L8 | **Mid-request failure injection** | `src/replica/server.ts`: today `/admin/kill` fails both `/health` and `/infer`. Add a mode where `/infer` fails (503 or a hang) while `/health` still answers, so request-driven ejection can be tested in isolation from health-check ejection. Keep it binary, no partial degradation. |
| L9 | **Unit tests** | error classification (each `kind`, `retryable` correct); `eject()` state machine (ejects on the call, does not recover before M successes, no flap on alternating probes, a real recovery still emits `unhealthy -> healthy`); the replica's `/infer`-only failure mode. |

---

## 4. Arundhati: Retry & Events track

| # | Task | Deliverable |
|---|---|---|
| L10 | **Engine candidate exclusion** | `src/routing/engine.ts`: `route()` accepts an optional `{ exclude?: string[] }`; the engine filters `healthy` down by the exclude set before delegating to the strategy, and returns `no_routable_replica` when the set empties. No `RoutingStrategy` change (per §2). Keeps the M2 no-arg call working. |
| L11 | **Retry loop in `POST /route`** | `src/api/server.ts`: implement the L4 behaviour. On a retryable `sendRequest` rejection, call `scheduler.eject`, record the event, ask the engine for the next pick excluding the tried set, retry. Stop on a non-retryable error or on `WR_MAX_RETRIES` reached. Return the `200` + `attempts` body on success, `503 all_replicas_failed` on exhaustion. The `502 replica_request_failed` M2 body is replaced by this loop. |
| L12 | **Failover event store** | `src/events/failover-log.ts`: in-memory implementation of the L3 store. Subscribed to `HealthScheduler`'s `onTransition` (both `-> unhealthy` and `-> healthy`) and called directly by the retry loop on a request-failure ejection. Time-range query returns events in ascending `at` order. Sized for M5a; no persistence yet (M4/M5 territory). |
| L13 | **Failover config** | `src/config.ts`: add `WR_MAX_RETRIES` (default 2, integer >= 0) with validation, wired into the `/route` retry loop. Any cooldown knob L2 turns out to need lands here too. |
| L14 | **Unit tests** | engine exclusion (excludes the set, `no_routable_replica` when emptied); retry loop with a stubbed adapter and scheduler (first attempt fails then succeeds, records one event and reports `attempts`; all three fail, returns `503 all_replicas_failed`; non-retryable error, no retry, no ejection); event store query by range. |

---

## 5. Joint tasks

| # | Task | Split |
|---|---|---|
| L15 | **Shared contract doc** in `docs/milestones/m3/shared-contract.md`: the L1 through L4 decisions written up the way M2's was, plus the `docs/decisions.md` entries for the frozen strategy interface and the retuned hysteresis. | pair, Junaid drafts L1/L2, Arundhati drafts L3/L4 |
| L16 | **Main wiring** in `src/main.ts`: construct the failover event store, subscribe it to the scheduler, pass the scheduler's `eject` into the API server so the retry loop can call it, thread `WR_MAX_RETRIES`. Small diff on top of M2's `main.ts`. | whoever finishes their track first drafts, other reviews |
| L17 | **Zero-loss integration test** in `test/integration/m3.test.ts`: boot fleet + main, drive continuous `POST /route` load, kill one replica mid-run, assert **every** client response is `200` (zero loss), assert the killed replica leaves the candidate set within 1s (measure it), assert a failover event was recorded, then revive and assert the replica rejoins after M clean probes. | pair (PRD §11 flags M3 for joint debugging) |
| L18 | **M3 architecture review + README update** in `docs/architecture/m3.md`, same shape as [`m2.md`](../../architecture/m2.md): confirm no decision-log / MCP concerns leaked in (M4 / M5), report the measured `<1s` detection and zero-loss numbers from L17, confirm the adapter boundary still holds, both sign off. Update the README with the failover behaviour and the kill-under-load demo. | both |

Everything else, L5 through L9 and L10 through L14, is single-owner. The only
cross-track dependency is L11 (needs L5's error type, L6's `eject`, and L10's
exclusion) and L16 / L17 at the end.

---

## 6. Sequencing

1. **Day 1:** L15 shared contract (together, ~45 min).
2. **Day 1-2:** Junaid L5 (adapter errors), Arundhati L10 (engine exclusion) in
   parallel. Both only depend on §2.
3. **Day 2-3:** Junaid L6-L8, Arundhati L11-L13. Arundhati's L11 works against a
   stubbed error type and `eject` until L5 / L6 merge, then swaps to the real
   ones.
4. **Day 3-4:** Junaid L9 tests, Arundhati L14 tests. Still independent.
5. **Day 4:** L16 wiring (whoever is free first drafts, other reviews same day).
6. **Day 4-5:** L17 zero-loss integration test (pair).
7. **Day 5:** L7 final hysteresis numbers folded in, L18 review and sign-off.

Only hard dependency: L11 needs L1 / L2 agreed (not L5 / L6 built, it can be
written against the interfaces and stubs first). This is what lets both tracks
run parallel through most of the week.

---

## 7. Effort balance check

| | Junaid | Arundhati |
|---|---|---|
| Shared design authoring | L1 error taxonomy + L2 eject / recovery semantics | L3 event record + L4 retry behaviour |
| Large module | scheduler fast-eject + hysteresis tuning (L6, L7) | retry loop + engine exclusion (L10, L11) |
| Medium module | typed adapter errors (L5) | failover event store (L12) |
| Small module | mid-request fault injection (L8) | failover config (L13) |
| Tests | own modules (L9) | own modules (L14) |
| Joint | L15-L18, split evenly | same |

Each side: half the shared contract authored, comparable module weight (eject
path + tuning vs. retry loop + exclusion), own unit tests, half of every joint
task. Two of the four joint tasks (L16, L18 README half) are short by design so
neither person is blocked waiting on the other.

---

## 8. Working agreement

The commit / branch / PR / review rules live in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
at the repo root. They are project-wide, not M3-specific. In force for all of M3.

---

## 9. Definition of done (M3)

- `POST /route` retries against the next-best replica on a retryable failure, up
  to 2 retries (3 attempts total), then returns `503 all_replicas_failed` with
  the attempt list.
- A replica that fails a live request is out of the candidate pool immediately,
  not after N health probes.
- Killing one replica under steady `POST /route` load loses zero client
  requests, all retried successfully (validated in L17), per PRD §8.
- Failover detection, replica death to traffic shed, is under 1s, measured in
  L17, per PRD §8.
- An ejected or unhealthy replica recovers to `healthy` automatically after M
  consecutive clean probes, no faster.
- Every ejection and recovery writes a `FailoverEvent` queryable by time range.
- A non-retryable replica error is returned to the client without a retry and
  without ejecting the replica.
- Unit + integration tests green in CI.
- Both authors have signed off in M3's architecture review (L18).
