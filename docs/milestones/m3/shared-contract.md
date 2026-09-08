# M3 Shared Contract (L1 to L4)

**Status:** L1 and L2 drafted solo by Junaid (2026-09-06) and already built and
merged (PRs #30, #32), same pattern as M2's K1/K2. L3 and L4 drafted by
Arundhati (2026-09-07), not yet built. This doc is the single reference both
tracks work against; Arundhati reviews L1/L2 as merged, Junaid reviews L3/L4
before the retry loop lands.
**Covers:** the adapter error taxonomy (L1), the ejection and recovery semantics
(L2), the failover event record and its store (L3), and the `POST /route` retry
behaviour (L4).

Landed / to land as:
- L1: `src/adapter/types.ts` (`ReplicaRequestError`), `src/adapter/http.ts` (Junaid, merged)
- L2: `src/health/scheduler.ts` (`HealthScheduler.eject`) (Junaid, merged)
- L3: `src/events/types.ts` + `src/events/failover-log.ts` (Arundhati, L12)
- L4: `src/api/server.ts` (Arundhati, L11), `src/config.ts` (`WR_MAX_RETRIES`, L13)

Any change after sign-off goes through a PR that updates this doc and the
affected files together.

---

## L1: Adapter error taxonomy (`src/adapter/types.ts`)

```ts
export type ReplicaErrorKind = "timeout" | "connection" | "http_status";

export class ReplicaRequestError extends Error {
  readonly kind: ReplicaErrorKind;
  readonly retryable: boolean;
  /** HTTP status code, present only when kind === "http_status". */
  readonly status?: number;

  constructor(kind: ReplicaErrorKind, message: string, status?: number);
}
```

**Rules:**
- `sendRequest` rejects **only** with a `ReplicaRequestError` for a transport
  failure, a timeout, or a non-2xx response. It still throws a plain `Error`
  for a programmer mistake (an unregistered replica id), which is not a
  transport condition and not something the retry loop should ever see.
- `checkHealth` is unchanged: it still never rejects (M1 decision, 2026-09-01).
  The taxonomy is for `sendRequest` only.
- `ReplicaRequestError extends Error`, so any existing `catch (err)` that only
  reads `err.message` keeps working. New code narrows on `kind` / `retryable`.
- **Retryability, fixed here:**
  | `kind` | `retryable` |
  |---|---|
  | `timeout` | always `true` (replica is slow or dead) |
  | `connection` | always `true` (refused or unreachable, may be transient) |
  | `http_status`, `status >= 500` | `true` (server-side failure) |
  | `http_status`, `status` 4xx | `false` (bad payload; another replica of the same fleet would reject it too) |
- The HTTP adapter maps: `AbortError` from the timeout controller to `timeout`,
  any other `fetch` throw to `connection`, a non-2xx response to `http_status`
  with the code.

**Known simplification:** every 5xx is treated as retryable, including a `501`
or `505` that a homogeneous fleet would reject identically. Real replicas under
load emit `500` / `502` / `503` / `504`, all genuinely retryable, so this is
accepted for M3. Revisit only if a real backend starts returning a stable 5xx.

---

## L2: Ejection and recovery (`HealthScheduler.eject`, `src/health/scheduler.ts`)

```ts
eject(replicaId: string, reason: string): void
```

**Rules:**
- Marks the replica `unhealthy` **immediately**, without waiting for
  `unhealthyThreshold` failed probes. This is the request-driven failover path
  (task split §1): the health poll loop alone is `N * intervalMs` slow, which
  misses the PRD §8 "< 1s from replica death to traffic shed" target.
- Sets the internal hysteresis state to `{ health: "unhealthy", consecFailures:
  unhealthyThreshold, consecSuccesses: 0 }` and writes the same counters plus
  `health` through the sink, so a `/status` snapshot taken right after an eject
  is self-consistent. `inFlight`, `latencyMs`, and `lastCheckedAt` are **not**
  touched: an eject is not a probe and has no fresh measurement.
- **Recovery is unchanged.** An ejected replica returns to `healthy` only after
  `healthyThreshold` consecutive clean probes, exactly like a poll-driven
  `unhealthy`. It cannot rejoin on one lucky probe.
- Emits an `onTransition({ replicaId, from, to: "unhealthy", at, reason })` only
  when `from !== "unhealthy"`. Calling `eject` on an already-`unhealthy` replica
  is a safe no-op (it still calls `setHealth` idempotently, emits nothing).
- Throws on an unregistered replica id.
- Does **no logging of its own.** The `reason` string rides on the
  `HealthTransition`; `main.ts` logs it and the L3 store reads it.

**`HealthTransition` gained an optional field (merged in #32):**
```ts
export interface HealthTransition {
  replicaId: string;
  from: ReplicaHealth;
  to: ReplicaHealth;
  at: string;        // ISO 8601
  reason?: string;   // set by eject(); absent for poll-driven transitions
}
```
`reason` present on a transition means "this was an `eject()`, not the poll
loop". The L3 store uses that to set `trigger` (see below).

---

## L3: Failover event record (`src/events/`)

The queryable timeline of every ejection and recovery. This is **not** the M4
decision log (that is per-request routing rationale). It is the substrate M5a's
`get_failover_history(time_range)` reads.

```ts
// src/events/types.ts
export interface FailoverEvent {
  /** Unique id, crypto.randomUUID(). */
  id: string;
  replicaId: string;
  kind: "ejected" | "recovered";
  /** ISO 8601, from the triggering transition. */
  at: string;
  trigger: "health_check" | "request_failure";
  /** Human-readable cause, always populated (synthesized for poll-driven events). */
  reason: string;
  /** The request whose failure caused a request_failure ejection. Absent otherwise. */
  requestId?: string;
}

export interface FailoverLog {
  record(event: FailoverEvent): void;
  /** Events with from <= at <= to, both bounds optional and inclusive, ascending by `at`. */
  query(range: { from?: string; to?: string }): FailoverEvent[];
}
```

**How it is fed:**
- **Health-check transitions:** the store subscribes to the scheduler's
  `onTransition`. A transition to `unhealthy` with **no `reason`** becomes
  `{ kind: "ejected", trigger: "health_check", reason: "N consecutive failed probes" }`.
  A transition to `healthy` becomes
  `{ kind: "recovered", trigger: "health_check", reason: "M consecutive healthy probes" }`.
  A transition to `unknown` is never emitted, so it is not a case.
- **Request-driven ejections:** the retry loop (L4) calls `record()` directly
  with `trigger: "request_failure"`, the `requestId`, and a `reason` derived
  from the `ReplicaRequestError` (e.g. `"request failed: http_status 503"`).
  The `eject()` call it also makes fires an `onTransition` **with** a `reason`,
  and the store **skips** transitions that carry a `reason` so this event is
  not double-recorded.
- Recovery is always poll-driven, so recoveries always arrive via the
  subscription, never a direct call.

**Storage:** in-memory, unbounded for M3 (a demo-scale fleet produces a handful
of events). Persistence and a retention cap are M4 / M5 concerns, flagged not
built.

---

## L4: `POST /route` retry behaviour (`src/api/server.ts`)

The M2 endpoint picked one replica and, on a failed `sendRequest`, returned a
terminal `502`. M3 adds a bounded retry against the next-best replica.

**The loop:**
1. Ask the engine for a pick, excluding every replica already tried this
   request (empty on the first attempt).
2. If the engine returns `no_healthy_replicas` or `no_routable_replica`:
   - on the **first** attempt, return `503 { error: <that error> }` (M2
     behaviour, unchanged).
   - after at least one failed attempt, return `503 all_replicas_failed`
     (everyone routable has been tried and failed).
3. Call `sendRequest` on the pick.
   - **Success:** return `200` with the M2 body plus `attempts` (see below).
   - **Retryable `ReplicaRequestError`:** call `scheduler.eject(replicaId,
     reason)`, `failoverLog.record(...)`, append to `attempts`, and loop, up to
     `WR_MAX_RETRIES` retries.
   - **Non-retryable `ReplicaRequestError`:** stop. Return `502
     replica_request_failed`. Do **not** eject (a 4xx is the caller's fault,
     the replica is fine).
4. `WR_MAX_RETRIES` retries used and still failing: return `503
   all_replicas_failed`.

**Engine signature change (L10):**
```ts
route(opts?: { exclude?: readonly string[] }): RouteResult
```
The engine filters `healthy` down by `exclude` before delegating to the
strategy. No `RoutingStrategy` change: exclusion happens in the engine, the
strategy still just picks from what it is handed. The M2 no-arg call still
works. `exclude` is the deterministic mechanism; the `eject()` in step 3 is a
side effect for the health system's benefit, not what the loop relies on to
skip a replica.

**Response bodies:**

Success, `200`:
```json
{
  "replicaId": "replica-2",
  "strategy": "least-loaded",
  "response": {},
  "latencyMs": 14,
  "attempts": [
    { "replicaId": "replica-1", "kind": "timeout" }
  ]
}
```
`attempts` is the ordered list of **failed** tries before the one that
succeeded, `[]` on a first-try success. Each entry is
`{ replicaId: string; kind: ReplicaErrorKind; status?: number }`.

All routable replicas tried and failed, `503`:
```json
{ "error": "all_replicas_failed", "attempts": [ ... ] }
```

Chosen replica returned a non-retryable error, `502`:
```json
{ "error": "replica_request_failed", "replicaId": "replica-3", "detail": "...", "attempts": [ ... ] }
```

Fleet genuinely has nothing to route to on the first attempt, `503` (M2,
unchanged): `{ "error": "no_healthy_replicas" }` or `{ "error": "no_routable_replica" }`.

Malformed JSON body, `400` (M2, unchanged): `{ "error": "invalid_json_body" }`.

**Config (L13):** `WR_MAX_RETRIES`, default `2` (so 3 attempts total, matching
PRD §10). Integer `>= 0`; `0` means no retry, the M2 behaviour. Validated in
`src/config.ts`.

**Accepted risk:** a retried inference request runs twice on different replicas.
LLM inference is effectively re-runnable, and PRD §10 already chose bounded
retries over zero-loss-with-no-retry, so this is not solved in M3.

---

## Frozen by this contract

- **`RoutingStrategy` interface.** No `exclude` parameter on `pick`; the engine
  filters candidates before calling it. Recorded in `docs/decisions.md`.
- **`checkHealth` never rejects** (M1, 2026-09-01). L1 is `sendRequest` only.
- **Recovery is always hysteresis-gated** by `healthyThreshold`. Request-driven
  ejection has no fast-recovery counterpart.

## Not frozen

- **`RegistryStore` is still synchronous** (M1 deferral 1). First real need is
  M5a. The retry loop and the event store are written synchronously and will
  grow `await` with everything else when Redis lands.
- **Hysteresis thresholds** (`N` / `M` / interval) are still the un-measured
  M1 starting values. L7 tunes them against real probe latency and adds the
  `docs/decisions.md` entry; that is a separate task, not part of this contract.
- **`route()` still takes no request context.** Session or affinity routing
  (M4+) will change the signature again.

---

## Sign-off checklist

- [x] L1 error taxonomy shape and retryability table (Junaid, built in #30)
- [x] L2 `eject()` semantics, `HealthTransition.reason` (Junaid, built in #30 / #32)
- [x] L1 / L2 reviewed as merged (Junaid, 2026-09-08). Found and fixed one real
      bug in `eject()` while reviewing: a second `eject()` call on an
      already-`unhealthy` replica was resetting `consecSuccesses` to 0 even
      when a real health probe had already started counting toward recovery
      (e.g. a stale request, in flight before an earlier failure already
      ejected the same replica, arrives late and calls `eject` again). That
      erased earned recovery progress and delayed recovery by a full extra
      probe cycle, contradicting L2's own "cannot rejoin on one lucky probe /
      cannot be delayed by a duplicate ejection either" intent. Fixed: `eject`
      is now a true no-op when the replica is already `unhealthy`, it neither
      touches the counters nor emits a transition. Regression test added. See
      the PR that lands this entry.
- [x] L3 `FailoverEvent` shape, the feed rules, the `reason`-means-skip dedupe
      (Junaid, 2026-09-08): consistent as designed. Only `eject()` sets
      `reason`; recovery is always poll-driven per L2 so it never carries one,
      so there's no path where a recovered event could be double-recorded or
      dropped. Agreed.
- [x] L4 retry loop, the `attempts` entry shape (`{ replicaId, kind, status? }`,
      a change from the task split's `{ replicaId, error }` sketch), the
      `502` vs `503 all_replicas_failed` split (Junaid, 2026-09-08): agreed.
      The `attempts` shape change is a reasonable improvement over the task
      split's sketch, and non-retryable-doesn't-eject is the right call.
- [ ] `engine.route({ exclude })` signature (both — Junaid agrees, 2026-09-08; awaiting Arundhati)
- [ ] `WR_MAX_RETRIES` default of 2 (both — Junaid agrees, 2026-09-08, matches PRD §10 exactly; awaiting Arundhati)

Once every box is checked, L11 through L14 build against this doc.
