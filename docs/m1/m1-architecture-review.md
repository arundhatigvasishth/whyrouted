# M1 Architecture Review

**Reviewers:** Arundhati Vasishth, Junaid Pathan
**Date:** 2026-09-03
**Purpose:** Walk the adapter seam before M2. Confirm the one load-bearing
architectural bet is correctly implemented and that no routing / failover /
decision-log / MCP assumptions leaked into M1 code.

**Scope reviewed:** everything on `main` at merge of PR #15 —
`src/adapter/`, `src/health/`, `src/registry/`, `src/api/`, `src/replica/`,
`src/config.ts`, `src/types.ts`, `src/main.ts`, and the test suite (64 tests).

---

## 1. The bet: real network boundary, adapter swap

> PRD §6: "No routing, health, or MCP tool code changes between phases — this
> boundary is the single most important design decision in the project."

**Verdict: correctly implemented.**

- `ReplicaAdapter` (`src/adapter/types.ts`) is exactly the two functions from
  PRD §6, signatures verbatim: `checkHealth(replicaId) → { alive, latencyMs,
  inFlight }`, `sendRequest(replicaId, payload) → { response, latencyMs }`.
  Nothing else on the interface.
- `HttpReplicaAdapter` (`src/adapter/http.ts`) implements it against real HTTP —
  `fetch` with `AbortController` timeouts, id→URL resolution from the config
  replica list. A Phase 2 Ollama/vLLM adapter is a new file implementing the
  same interface; nothing above the boundary changes.
- Simulated replicas are real separate processes (`src/replica/launch.ts` spawns
  one child per replica), not in-process fakes. This is what keeps Phase 2 an
  adapter swap rather than a transport-layer rewrite.
- The integration test (`test/integration/m1.test.ts`) exercises the boundary
  over a real socket, not a mock.

## 2. Does the code match the final architecture diagram (PRD §6)?

| Diagram element | M1 state | OK? |
|---|---|---|
| Health Scheduler ──writes──▶ Service Registry | `scheduler` writes through `HealthSink` (a `Pick<RegistryStore, "updateRuntime" \| "setHealth">`) — it doesn't even see the whole registry | ✅ |
| Service Registry (Redis-backed) | `Registry` (in-memory) behind `RegistryStore` interface; `RedisRegistry` stub implements the same interface | ✅ seam proven, swap deferred |
| Replica Adapter ◀── swappable | `HttpReplicaAdapter implements ReplicaAdapter`; concrete class named only in `main.ts` | ✅ |
| Health Scheduler as its own service (later) | `HealthScheduler` depends only on `ReplicaAdapter` + `HealthSink` interfaces, no concrete imports; timer is `.unref()`'d so it doesn't own process lifecycle | ✅ extractable, not a rewrite |
| whyrouted API / routing engine | not in M1 (M2) | ✅ absent |
| Decision Log | not in M1 (M4) | ✅ absent |
| MCP Server | not in M1 (M5) | ✅ absent |

## 3. Leakage check — did any later-milestone concern get built in?

Grepped `src/` for `rout`, `score`, `weight`, `strateg`, `mcp`, `decision`,
`least-load`, `pick`, `select…replica`, `best`.

**Every hit is a comment pointing forward** ("M2's router", "router (M2) can
catch and retry", "once routing lands"). **Zero routing / scoring / strategy /
MCP / decision-log code exists.** Clean.

- `sendRequest` is fully implemented in `http.ts` but has **no caller** in M1 —
  it exists to make the boundary complete, not because anything routes yet. This
  is the right call: the interface is whole, but no premature router.
- `/status` is one read route. No auth, no query params, no other endpoints —
  the request-serving surface is M2.

## 4. Known deferrals — carry into M2/M3, do not fix now

1. **`RegistryStore` is synchronous.** A real Redis implementation returns
   Promises. When Redis lands (first needed at M5a, when the MCP server becomes
   a second registry consumer), every `sink.updateRuntime(...)` in the scheduler
   and the `/status` handler grows an `await`. Acceptable deferral — no second
   consumer exists yet. Flagged in PR #6.
2. **`sendRequest` throws a generic `Error` on non-2xx.** M2's router needs to
   tell retryable (503, timeout, connection refused) from non-retryable to do
   failover. The adapter will need typed/coded errors then. Not M1's problem —
   nothing calls it yet.
3. **All replicas launch with `DEFAULT_PROFILE`.** `synthetic.ts` supports
   per-replica load/latency profiles but `launch.ts` doesn't thread them
   through. M2 load-distribution testing (success metric: no replica > 1.5×
   median utilization) will want distinct profiles. Small change to the launcher.
4. **Health transitions are logged to console and lost.** M3 (failover events)
   and M4 (decision log) introduce persistence. M1 doesn't need it.
5. **`main.ts` hardcodes the 5s fleet-readiness wait** rather than deriving it
   from config. Cosmetic; revisit if it's flaky in CI.

## 5. Assumptions from `m1-fleet-foundation.md` — still open, need live data

These were flagged as "validate later" in the direction doc and remain open —
they need M2/M3 measurement, not a design-review answer:

- [ ] Real HTTP call overhead stays under the "<10ms p99 routing overhead"
      budget (measure in M2).
- [ ] In-flight count is a good enough load proxy under bursty load (watch in
      M2 load testing).
- [ ] N=3 / M=2 hysteresis at a 1s interval hits "<1s failover detection"
      without flapping (tune live in M3).

## 6. Sign-off

- [x] Adapter boundary matches PRD §6 exactly — Arundhati
- [x] No routing / failover / decision-log / MCP code in M1 — Arundhati
- [x] Registry and scheduler are shaped for their final split-out — Arundhati
- [ ] Replica & health track walked and agreed — Junaid
- [ ] Clear to start M2 — both

**Once both boxes above are checked, M1 is closed and M2 planning begins.**
