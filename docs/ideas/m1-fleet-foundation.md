# M1: Fleet Foundation (Registry + Health Scheduler + Simulated Replicas)

## Problem Statement

How might we build the smallest possible foundation — a service registry, a health scheduler, and a fleet of simulated replicas — that (a) proves the routing engine can observe live replica state over a real network boundary, and (b) sets up the adapter interface so Phase 2 (real replicas) is a swap, not a rewrite?

## Recommended Direction

Build M1 as a single Node.js/TypeScript program that contains three internal pieces — a service registry (in-memory for local dev, Redis-backed later), a health scheduler polling every replica on a 1s interval, and a `GET /status` endpoint exposing the registry snapshot as JSON. Simulated replicas are **real, separate local HTTP servers** (each its own process on its own port) with fluctuating synthetic load/latency and a simple on/off kill switch — not in-process fakes.

This shape is deliberately conservative on two axes (single process, simple on/off failure) and deliberately strict on one (real network calls to replicas), because that third axis is the one the PRD's core architectural bet depends on: "no routing, health, or MCP tool code changes between phases." If replicas were in-process objects at M1, swapping to real Ollama/vLLM servers in Phase 2 would require rewriting the transport layer, not just the adapter — undermining the single most important design decision in the project. The other two axes (one process, simple kill/revive) buy build speed now without foreclosing anything: the health-checking logic is written as its own internal module specifically so extracting it into a separate service later (matching the final architecture diagram) is a small refactor, not a rewrite; and richer failure modes (partial degradation, flapping, latency spikes) can be layered onto the same kill-switch interface once the core failover loop (M3) is proven.

## Key Assumptions to Validate

- [ ] Real HTTP calls between the routing engine and simulated replicas add negligible overhead — check this doesn't threaten the "<10ms p99 routing overhead" success metric before M2.
- [ ] In-flight request count (no queue depth) is a good enough load proxy under synthetic bursty load — watch for this during M2's load-distribution testing; revisit if one replica's utilization exceeds 1.5x median despite even in-flight counts.
- [ ] A 1s health-check interval with N-failures-to-unhealthy / M-successes-to-recovered hysteresis is enough to hit "<1s failover detection" without flapping — needs live testing at M3, not just design review.

## MVP Scope

**In:**
- Service registry (in-memory map; Redis-backed path stubbed but not required to work at M1)
- Health scheduler (1s interval, hysteresis-based up/down transitions)
- Simulated replica processes: real HTTP servers, each exposing a health/inference endpoint, configurable synthetic load + latency, and a kill/revive switch
- `GET /status` HTTP endpoint returning the full registry snapshot as JSON

**Out (until later milestones):**
- Routing logic itself (M2)
- Failover/retry behavior (M3)
- Decision log (M4)
- MCP server, dashboard, Docker, Kubernetes (M5+)

## Not Doing (and Why)

- **Redis for real, right now** — in-memory fallback is explicitly what the PRD calls for at local-dev stage; wiring real Redis before there's a second consumer of the registry is premature infra.
- **Rich failure modes (degradation, flapping, latency spikes)** — adds a harder scoring problem (how do you rank a "half-healthy" replica?) before the binary failover loop is even proven. Revisit after M3.
- **Separate health-scheduler process/service** — matches the final architecture eventually, but two coordinated processes before Docker/K8s exist to manage that coordination is unnecessary overhead for M1.
- **Queue-depth load signal** — not exposed uniformly by real replica backends (Ollama/vLLM) later, so building around it now would complicate the Phase 2 adapter swap for a signal not yet proven necessary.

## Open Questions

- Exact hysteresis values (N failures to mark unhealthy, M successes to recover) — needs to be tuned once real health-check latency is observed, not decided in the abstract.
- Shape of the synthetic load/latency generator for simulated replicas (fixed distribution vs. configurable per-replica profiles) — a spec-level detail, not a direction-level one.

---

*Feeds into: `/spec-driven-development` for M1 implementation spec.*
*Upstream: PRD v3 (`PRDv3.md`), confirmed intent from `/interview-me` session (2026-08-31/09-01).*
