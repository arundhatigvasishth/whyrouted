# Decisions

Load-bearing technical decisions and why we made them. Newest first. Add an entry
when a choice would be expensive to reverse or isn't obvious from the code.

---

## 2026-09-03: `RegistryStore` interface is synchronous

The registry interface methods return values directly, not Promises, matching the
in-memory implementation.

**Why:** the only M1 implementation is an in-memory `Map`, which is instant.
Making the interface async now would push `await` into the health scheduler, the
`/status` handler, and `main.ts` for no M1 benefit.

**Revisit when:** a Redis-backed store is actually built (first real need is M5a,
when the MCP server becomes a second registry consumer). At that point the
interface widens to Promise-returning and the call sites grow `await`.

## 2026-09-03: health scheduler stays in-process for M1

Not extracted into its own service, despite the final architecture showing it
separate.

**Why:** two coordinated processes before Docker/K8s exist to manage them is
overhead with no payoff. The scheduler is written to depend only on the
`ReplicaAdapter` and `HealthSink` interfaces, so extracting it later is a
refactor, not a rewrite.

**Revisit when:** M8 (deployment), where each component becomes its own K8s
deployment.

## 2026-09-01: replica adapter boundary is exactly two functions

Everything reaches replicas through `checkHealth(replicaId)` and
`sendRequest(replicaId, payload)`, nothing else.

**Why:** this is the single most important design decision in the project (PRD
§6). Phase 2 swaps simulated replicas for real model servers (Ollama / vLLM) by
implementing the same two functions. No routing, health, or MCP code changes.

**Revisit when:** never, ideally. If the boundary needs a third method, that's a
signal worth stopping for.

## 2026-09-01: `checkHealth` never rejects; `sendRequest` rejects

A failed health probe resolves with `{ alive: false, latencyMs: <timeout>,
inFlight: 0 }`. A failed inference request throws.

**Why:** the scheduler polls constantly and a dead replica is a normal, expected
state, not an exception. An inference request failing is a real error the future
router needs to catch and retry against another replica.

**Note:** on a failed probe the scheduler writes `latencyMs: null` into the
runtime. The timeout value from the adapter is not persisted. `latencyMs` in the
registry only ever holds a real successful round-trip.

## 2026-09-01: load signal is in-flight count only, not queue depth

**Why:** in-flight count comes straight out of `checkHealth`. Queue depth isn't
uniformly exposed by real replica backends (Ollama / vLLM), so building around it
now would complicate the Phase 2 adapter swap for a signal not yet proven
necessary.

**Revisit when:** M2 load-distribution testing, if a replica exceeds 1.5x median
utilization despite even in-flight counts.

## 2026-09-01: simulated replicas are real separate processes

Each simulated replica is its own HTTP server on its own port, spawned as a child
process, not an in-process fake object.

**Why:** if replicas were in-process objects, swapping to real Ollama / vLLM
servers in Phase 2 would mean rewriting the transport layer, not just the
adapter. Real processes keep the Phase 2 swap an adapter swap.

## 2026-09-01: hysteresis thresholds are N=3 fail, M=2 recover, 1s interval

A replica is marked `unhealthy` after 3 consecutive failed probes, and recovers
to `healthy` after 2 consecutive successes.

**Why:** starting values that stop a single blip from flapping a replica in and
out of rotation. Not derived from measurement.

**Revisit when:** M3, tuned against observed real health-check latency to hit the
"<1s failover detection" target without flapping.

## 2026-08-31: real replicas (Ollama / vLLM) stay local-only

Phase 2's real-replica adapter is never deployed to EKS. Only the simulated fleet
runs on the cluster for the final demo.

**Why:** real inference servers need GPU nodes, model weights, and real cost that
don't serve the project's differentiator (routing, failover, explainability via
MCP). The simulated adapter exercises the same interface, so EKS still proves the
infrastructure pattern.
