# **whyrouted: Product Requirements Document (v3)**

**Authors:** Arundhati Vasishth, Junaid Pathan **Status:** Draft v3, open questions resolved, M1 scoped **Last updated:** September 2026

---

## **1\. Summary**

whyrouted is an inference-aware load balancer for LLM serving fleets. It routes each incoming request to the healthiest, least-loaded model replica, detects and routes around failures in under a second, and, unlike existing routers, exposes the *entire* fleet as a set of MCP (Model Context Protocol) tools, so any MCP-compatible client can not just ask why a decision was made, but observe, explain, and operate the fleet in real time.

**One line:** A smart traffic manager for AI model servers that you can talk to, and that you can control, grounded in real recorded data, not guesses.

---

## **2\. Problem**

Teams serving LLMs run multiple replicas of the same model behind a single endpoint. The routing layer between those replicas and the endpoint is usually one of two things:

* **Naive:** round-robin or random, ignoring that one replica may be saturated, cold, or dying.  
* **Opaque:** when latency spikes or a request fails, there is no way to reconstruct why traffic went where it did, and no way to intervene except editing a config file and redeploying.

Existing gateways (litellm, various AI proxies) solve provider fan-out and cost tracking well. None of them treat routing explainability or live operability as first-class features. When an on-call engineer asks "why did p99 blow up at 3:04am?", or needs to pull a dying replica out of rotation *right now*, the answer today is manual log archaeology and a redeploy.

---

## **3\. Goals & Non-Goals**

### **Goals**

* Route requests to the best available replica based on live load and health signals  
* Detect replica failure and shed traffic away from it within one health-check interval  
* Persist a structured decision record for every routed request  
* Expose the fleet's full state, history, and controls as **MCP tools**: both read (status, explain, history) and write (drain, restore, retune, simulate failure)  
* Answer natural-language questions about past routing decisions, grounded only in recorded data, no fabricated figures  
* Ship a live dashboard showing fleet state, request flow, MCP tool-call activity, and failover events  
* Deploy the full system on Kubernetes (AWS EKS), demonstrating a real, production-shaped infrastructure pattern, not just a local demo

### **Non-Goals (v1)**

* Multi-provider fan-out or cost optimization across vendors; this routes across replicas of your own fleet  
* Autoscaling or provisioning new replicas (routing across a fixed fleet only)  
* Authentication, rate limiting, billing  
* Production-grade throughput benchmarks at real scale

---

## **4\. Users**

| User | Need |
| ----- | ----- |
| ML platform engineer | Keep an LLM fleet available without hand-tuning routing |
| On-call engineer | Understand a latency or error incident quickly, after the fact, and act on it immediately |
| Team lead | See fleet utilization and failure history at a glance |
| AI agent (via MCP) | Autonomously monitor and remediate fleet issues without a human in the loop |

---

## **5\. Core Features**

### **5.1 Service registry**

A live record of every replica in the fleet and its current state: reachable, current in-flight request count, recent latency, consecutive health-check failures. Redis-backed for real multi-instance deployment (in-memory fallback for local dev).

### **5.2 Health checking**

A scheduler polls every replica on a fixed interval (default 1s), recording liveness and response latency. A replica is marked unhealthy after N consecutive failures and recovered after M consecutive successes (hysteresis prevents flapping).

### **5.3 Routing engine**

Scores each healthy replica on a weighted combination of in-flight load and recent latency, and routes to the best. Pluggable strategy interface so round-robin, least-loaded, and latency-weighted can be swapped and compared live, including via MCP tool call, not just config.

### **5.4 Failover**

When a replica fails health checks or a request to it errors out, it is removed from the candidate pool immediately and in-flight requests are retried against the next-best replica. Recovery is automatic once health checks pass again.

### **5.5 Decision log**

Every routing decision writes a structured record: request ID, timestamp, chosen replica, the full candidate set with each one's score inputs at decision time, and the reason for any exclusion. This is the substrate every MCP read tool queries.

### **5.6 MCP Interface Layer ⭐ (core differentiator)**

The entire fleet, its state, its history, and its controls, is exposed as a standard MCP server, so any MCP-compatible client (Claude, an agent, a custom ops CLI) can observe and operate whyrouted without a bespoke API integration.

**Read / diagnostic tools**

| Tool | Description |
| ----- | ----- |
| `get_fleet_status()` | Live snapshot of every replica's health, load, and latency |
| `explain_routing_decision(request_id)` | Grounded, cited explanation of why a specific request was routed where it was |
| `get_failover_history(time_range)` | Timeline of failures and recoveries in a window |
| `query_decisions(natural_language_query)` | Free-form question answered strictly from decision-log data |

**Action / control tools**

| Tool | Description |
| ----- | ----- |
| `drain_replica(replica_id)` | Gracefully stop routing new traffic to a replica |
| `restore_replica(replica_id)` | Return a drained replica to the candidate pool |
| `simulate_failure(replica_id)` | Trigger a controlled crash for testing/demo |
| `set_routing_strategy(strategy)` | Swap round-robin / least-loaded / latency-weighted live |
| `set_scoring_weights(load_weight, latency_weight)` | Tune the routing engine's live scoring |

**Grounding constraint:** every read tool's answer must be traceable to specific decision-log records or registry state at query time. If the data doesn't support an answer, the tool says so explicitly rather than inferring.

**MCP client.** For the core demo, the MCP server connects to Claude Desktop / claude.ai as the client. This is the standard, zero-extra-build way to show the server working end to end. As a stretch goal (see M10), a minimal custom CLI client removes any dependency on a specific provider's credits or app being available at demo time, and additionally demonstrates understanding of the client side of MCP, not just the server side.

### **5.7 Dashboard**

React UI showing live replica health and load, a request-flow view, a failover event timeline, an MCP tool-call activity feed (so you can see an agent's actions as they happen), and a natural-language query box.

---

## **6\. Architecture**

```
                     client requests
                            │
                            ▼
                  ┌───────────────────┐
                  │  whyrouted API    │──── writes ──▶  Decision Log
                  │  routing engine   │                      │
                  └─────────┬─────────┘                      │
                            │ reads                           │ reads
                            ▼                                 ▼
                  ┌───────────────────┐          ┌──────────────────────┐
                  │  Service Registry │◀── writes─│    MCP Server        │
                  │  (Redis-backed)   │           │  read + action tools │
                  └─────────▲─────────┘           └──────────┬───────────┘
                            │ writes                          │
                  ┌─────────┴─────────┐                       │ tool calls
                  │  Health Scheduler │                       ▼
                  └─────────┬─────────┘            MCP Client (Claude / agent / CLI)
                            │ polls
                            ▼
                  ┌────────────────────────────┐
                  │      Replica Adapter        │ ◀── swappable
                  │    simulated | real         │
                  └────────────────────────────┘
```

**Replica adapter boundary.** The routing engine talks to replicas through exactly two functions:

```
checkHealth(replicaId) → { alive, latencyMs, inFlight }
sendRequest(replicaId, payload) → { response, latencyMs }
```

Phase 1 implements these against simulated replicas with fluctuating synthetic load, latency, and manually triggerable crashes. Phase 2 implements the same interface against real model servers (e.g., small local models via Ollama, or vLLM instances). No routing, health, or MCP tool code changes between phases. This boundary is the single most important design decision in the project.

---

## **7\. Tech Stack**

| Layer | Choice |
| ----- | ----- |
| Routing service | Node.js \+ Express (TypeScript) |
| Registry | Redis |
| Decision log | Structured JSON lines → SQLite (Postgres-compatible schema for future scale) |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript), tools per Section 5.6 |
| MCP client (stretch) | Minimal CLI script: LLM API call with MCP tools attached, prints grounded answer |
| Dashboard | React \+ WebSocket for live updates |
| Simulated replicas | Local processes with configurable load/latency/failure injection |
| Real replicas (Phase 2\) | Ollama or vLLM instances (small local models) |
| Containerization | Docker \+ Docker Compose (local dev) |
| Orchestration | Kubernetes (AWS EKS): routing service, MCP server, and replicas each as separate deployments |
| Ingress / load balancing into the cluster | AWS ALB (Application Load Balancer) via AWS Load Balancer Controller |
| Secrets / config | Kubernetes Secrets \+ ConfigMaps |
| Observability (deployment-level) | Basic CloudWatch or Prometheus/Grafana on the cluster (stretch goal) |
| CI | GitHub Actions: build, test, push image, (stretch: auto-deploy to EKS) |

---

## **8\. Success Metrics**

| Metric | Target |
| ----- | ----- |
| Failover detection time | \< 1s from replica death to traffic shed |
| Request loss during single-replica failure | 0 (all retried successfully) |
| p99 routing overhead | \< 10ms added per request |
| Explainability accuracy | 100% of answers grounded in decision-log values, no fabricated figures |
| Load distribution | No replica \> 1.5× median utilization under steady load |
| MCP action reliability | 100% of drain/restore/strategy-change tool calls correctly reflected in live fleet state within 1s |
| Deployment | Full stack running on EKS, reachable via a public ALB endpoint |

---

## **9\. Milestones**

| Phase | Scope |
| ----- | ----- |
| M1 | Simulated replicas \+ registry \+ health scheduler; replicas visible and pollable |
| M2 | Routing engine with pluggable strategies; requests distributed by load/latency |
| M3 | Failover \+ recovery with hysteresis; zero-loss demo on injected crash |
| M4 | Decision log with full candidate-set capture |
| M5a | MCP server: read-only tools (status, explain, history, query) working end-to-end |
| M5b | MCP server: action tools (drain, restore, simulate-failure, strategy/weight tuning) working end-to-end |
| M6 | React dashboard: live fleet state, flow view, failover timeline, MCP activity feed, query box |
| M7 | Dockerize all services; local Docker Compose demo fully working |
| M8 | Deploy to AWS EKS: routing service, MCP server, dashboard, and simulated replicas all running as Kubernetes deployments behind an ALB |
| M9 (stretch) | Real-replica adapter (Ollama/vLLM) swapped in behind the same interface, deployed |
| M10 (stretch) | Minimal custom CLI MCP client that sends a question/command to an LLM with whyrouted's tools attached, prints the grounded answer, no dependency on Claude Desktop |

**Demo definition of done:** On a live Kubernetes cluster, kill a replica, watch traffic reroute with zero failed requests, then use an MCP client to ask why a specific request went where it did and get a correct, grounded answer, then use the same client to drain a struggling replica and watch the dashboard reflect it in real time.

### **M1 Implementation Notes**

Decisions made ahead of M1 kickoff (registry + health scheduler + simulated replicas):

* **Simulated replicas are real, separate local HTTP processes** (each its own server on its own port with a `/health` endpoint), not in-process fake objects. This is the load-bearing choice: it's what makes the Phase 2 swap to real Ollama/vLLM replicas an adapter swap rather than a transport-layer rewrite, preserving the "no routing/health/MCP code changes between phases" bet in Section 6.  
* **Fault injection starts simple:** a replica is either fully up or fully down (kill/revive), no partial degradation. Sufficient for M3's zero-loss failover demo; richer failure modes (latency spikes, flapping, partial errors) are deferred until the core failover loop is proven.  
* **M1 runs as a single Node/TypeScript process** (registry, health scheduler, and a `GET /status` endpoint all together), not yet split into separate services. Health-checking logic is written as its own internal module so extracting it into a separate service later (matching the Section 6 diagram) is a small refactor, not a rewrite. Deferred until Docker/K8s (M7/M8) exist to manage that coordination.  
* **Default simulated fleet size:** 4 replicas, configurable, enough to demonstrate load distribution and a clean single-replica failover without noise.

---

## **10\. Key Decisions (formerly Open Questions)**

* **Scoring weights for load vs. latency.** → Fixed sane defaults at startup (e.g. 0.5/0.5), live-adjustable via `set_scoring_weights`. No self-tuning in v1; that's a research-scoped feature (needs an objective function, oscillation guardrails) that doesn't match the project's other non-goals (no autoscaling, no production-scale benchmarking).  
* **Aggregate vs. per-request NL queries.** → `query_decisions` supports **both** in v1: per-request lookups (e.g. "why did request X go where it did") and aggregate stats over a time range (e.g. "what happened to p99 between 3:00 and 3:10?"). The decision log design must support range queries and percentile computation, not just point lookups.  
* **Retry policy.** → Up to 2 retries against the next-best replica (3 attempts total) before returning an error to the client. Bounded to avoid cascading load onto already-struggling replicas during a correlated failure; comfortably covers the "zero loss on single-replica failure" success metric without unbounded retries.  
* **Load signal: queue depth vs. in-flight count.** → In-flight count only for v1. Directly available from the adapter interface (`checkHealth` returns `inFlight`) with no extra plumbing; queue depth isn't uniformly exposed by real replica backends (Ollama/vLLM), so building around it now would complicate the Phase 2 adapter swap. Revisit if load distribution misbehaves under bursty synthetic load (success metric: no replica \> 1.5× median utilization).  
* **Real replicas (Ollama/vLLM) on EKS.** → **No.** Phase 2 stays local-only. Only the simulated fleet gets deployed to EKS for the final demo. Real inference servers need GPU/beefy nodes, real model weights, and real cost/time that don't serve the project's actual differentiator (routing, failover, explainability via MCP); the simulated adapter already exercises the same interface, so EKS still proves the infrastructure pattern.

---

## **11\. Division of Labor (suggested)**

| Owner | Scope |
| ----- | ----- |
| Person A | Routing engine, service registry, health scheduler, failover logic, EKS deployment |
| Person B | Decision log, MCP server (read \+ action tools), dashboard, MCP activity feed |

Both: architecture review at each milestone boundary, joint debugging on M3 (failover) and M8 (deployment), since these are the highest-risk integration points.

