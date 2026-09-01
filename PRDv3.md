# **whyrouted — Product Requirements Document (v3)**

**Authors:** Arundhati Vasishth, Junaid Pathan **Status:** Draft v2 **Last updated:** August 2026

---

## **1\. Summary**

whyrouted is an inference-aware load balancer for LLM serving fleets. It routes each incoming request to the healthiest, least-loaded model replica, detects and routes around failures in under a second, and — unlike existing routers — exposes the *entire* fleet as a set of MCP (Model Context Protocol) tools, so any MCP-compatible client can not just ask why a decision was made, but observe, explain, and operate the fleet in real time.

**One line:** A smart traffic manager for AI model servers that you can talk to, and that you can control — grounded in real recorded data, not guesses.

---

## **2\. Problem**

Teams serving LLMs run multiple replicas of the same model behind a single endpoint. The routing layer between those replicas and the endpoint is usually one of two things:

* **Naive:** round-robin or random, ignoring that one replica may be saturated, cold, or dying.  
* **Opaque:** when latency spikes or a request fails, there is no way to reconstruct why traffic went where it did, and no way to intervene except editing a config file and redeploying.

Existing gateways (litellm, various AI proxies) solve provider fan-out and cost tracking well. None of them treat routing explainability or live operability as first-class features. When an on-call engineer asks "why did p99 blow up at 3:04am?" — or needs to pull a dying replica out of rotation *right now* — the answer today is manual log archaeology and a redeploy.

---

## **3\. Goals & Non-Goals**

### **Goals**

* Route requests to the best available replica based on live load and health signals  
* Detect replica failure and shed traffic away from it within one health-check interval  
* Persist a structured decision record for every routed request  
* Expose the fleet's full state, history, and controls as **MCP tools** — both read (status, explain, history) and write (drain, restore, retune, simulate failure)  
* Answer natural-language questions about past routing decisions, grounded only in recorded data — no fabricated figures  
* Ship a live dashboard showing fleet state, request flow, MCP tool-call activity, and failover events  
* Deploy the full system on Kubernetes (AWS EKS), demonstrating a real, production-shaped infrastructure pattern, not just a local demo

### **Non-Goals (v1)**

* Multi-provider fan-out or cost optimization across vendors — this routes across replicas of your own fleet  
* Autoscaling or provisioning new replicas (routing across a fixed fleet only)  
* Authentication, rate limiting, billing  
* Production-grade throughput benchmarks at real scale

---

## **4\. Users**

| User | Need |
| ----- | ----- |
| ML platform engineer | Keep an LLM fleet available without hand-tuning routing |
| On-call engineer | Understand a latency or error incident quickly, after the fact — and act on it immediately |
| Team lead | See fleet utilization and failure history at a glance |
| AI agent (via MCP) | Autonomously monitor and remediate fleet issues without a human in the loop |

---

## **5\. Core Features**

### **5.1 Service registry**

A live record of every replica in the fleet and its current state: reachable, current in-flight request count, recent latency, consecutive health-check failures. Redis-backed for real multi-instance deployment (in-memory fallback for local dev).

### **5.2 Health checking**

A scheduler polls every replica on a fixed interval (default 1s), recording liveness and response latency. A replica is marked unhealthy after N consecutive failures and recovered after M consecutive successes (hysteresis prevents flapping).

### **5.3 Routing engine**

Scores each healthy replica on a weighted combination of in-flight load and recent latency, and routes to the best. Pluggable strategy interface so round-robin, least-loaded, and latency-weighted can be swapped and compared live — including via MCP tool call, not just config.

### **5.4 Failover**

When a replica fails health checks or a request to it errors out, it is removed from the candidate pool immediately and in-flight requests are retried against the next-best replica. Recovery is automatic once health checks pass again.

### **5.5 Decision log**

Every routing decision writes a structured record: request ID, timestamp, chosen replica, the full candidate set with each one's score inputs at decision time, and the reason for any exclusion. This is the substrate every MCP read tool queries.

### **5.6 MCP Interface Layer ⭐ (core differentiator)**

The entire fleet — its state, its history, and its controls — is exposed as a standard MCP server, so any MCP-compatible client (Claude, an agent, a custom ops CLI) can observe and operate whyrouted without a bespoke API integration.

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

**MCP client.** For the core demo, the MCP server connects to Claude Desktop / claude.ai as the client — this is the standard, zero-extra-build way to show the server working end to end. As a stretch goal (see M10), a minimal custom CLI client removes any dependency on a specific provider's credits or app being available at demo time, and additionally demonstrates understanding of the client side of MCP, not just the server side.

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

Phase 1 implements these against simulated replicas with fluctuating synthetic load, latency, and manually triggerable crashes. Phase 2 implements the same interface against real model servers (e.g., small local models via Ollama, or vLLM instances). No routing, health, or MCP tool code changes between phases — this boundary is the single most important design decision in the project.

---

## **7\. Tech Stack**

| Layer | Choice |
| ----- | ----- |
| Routing service | Node.js \+ Express (TypeScript) |
| Registry | Redis |
| Decision log | Structured JSON lines → SQLite (Postgres-compatible schema for future scale) |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript), tools per Section 5.6 |
| MCP client (stretch) | Minimal CLI script — LLM API call with MCP tools attached, prints grounded answer |
| Dashboard | React \+ WebSocket for live updates |
| Simulated replicas | Local processes with configurable load/latency/failure injection |
| Real replicas (Phase 2\) | Ollama or vLLM instances (small local models) |
| Containerization | Docker \+ Docker Compose (local dev) |
| Orchestration | Kubernetes (AWS EKS) — routing service, MCP server, and replicas each as separate deployments |
| Ingress / load balancing into the cluster | AWS ALB (Application Load Balancer) via AWS Load Balancer Controller |
| Secrets / config | Kubernetes Secrets \+ ConfigMaps |
| Observability (deployment-level) | Basic CloudWatch or Prometheus/Grafana on the cluster (stretch goal) |
| CI | GitHub Actions — build, test, push image, (stretch: auto-deploy to EKS) |

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
| M10 (stretch) | Minimal custom CLI MCP client — sends a question/command to an LLM with whyrouted's tools attached, prints the grounded answer, no dependency on Claude Desktop |

**Demo definition of done:** On a live Kubernetes cluster, kill a replica, watch traffic reroute with zero failed requests, then use an MCP client to ask why a specific request went where it did and get a correct, grounded answer — then use the same client to drain a struggling replica and watch the dashboard reflect it in real time.

---

## **10\. Open Questions**

* Scoring weights for load vs. latency — fixed, configurable, or self-tuning from observed outcomes? (Now directly answerable via `set_scoring_weights` — decide default behavior.)  
* Should the MCP query tool support aggregate questions ("what happened to p99 between 3:00 and 3:10?") in v1, or only per-request questions?  
* Retry policy: how many replicas deep before returning an error to the client?  
* Is queue depth a better load signal than in-flight count for LLM workloads with variable token counts?  
* Do we deploy real replicas (Ollama/vLLM) on EKS for the final demo, or keep Phase 2 local and only deploy the simulated version to the cluster? (Cost/time tradeoff — decide by M7.)

---

## **11\. Division of Labor (suggested)**

| Owner | Scope |
| ----- | ----- |
| Person A | Routing engine, service registry, health scheduler, failover logic, EKS deployment |
| Person B | Decision log, MCP server (read \+ action tools), dashboard, MCP activity feed |

Both: architecture review at each milestone boundary, joint debugging on M3 (failover) and M8 (deployment), since these are the highest-risk integration points.

