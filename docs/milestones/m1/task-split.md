# M1 Task Split — Fleet Foundation

**Authors:** Arundhati Vasishth, Junaid Pathan
**Scope:** M1 only (registry + health scheduler + simulated replicas + `GET /status`)
**Goal of this doc:** divide M1 into two tracks of equal weight so both people own a
comparable slice of design, a comparable slice of build, and their own tests.

---

## 1. Principle

M1 has one hard architectural bet (real network calls to replicas so Phase 2 is an
adapter swap) and two deliberately conservative choices (single process, on/off
failure). The two tracks below are cut along the natural integration seam:

- **Junaid — Replica & Health track:** everything on the far side of the adapter
  boundary + the thing that polls across it.
- **Arundhati — Registry & Service track:** everything that stores fleet state and
  exposes it.

Neither track can be demoed alone, so the seam (adapter interface + shared types)
is designed jointly *before* either side writes code.

> **Note on overall project balance.** The PRD's suggested division (§11) front-loads
> M1 onto "Person A". This doc rebalances M1 specifically. To keep total
> contribution even across the project, Junaid picks up extra scope later where
> Arundhati's PRD track is heavy: **M5b action tools** and **M6 dashboard flow view**
> are Junaid-assisted. Revisit at each milestone boundary.

---

## 2. Shared contract (design together first — ~45 min, before any code)

Produce two files by pairing; commit them before splitting off.

| Item | File | Notes |
|---|---|---|
| **J1** Adapter interface | `src/adapter/types.ts` | `checkHealth(replicaId) → { alive, latencyMs, inFlight }`, `sendRequest(replicaId, payload) → { response, latencyMs }`. Exact signatures from PRD §6. No implementation yet. |
| **J2** Shared domain types | `src/types.ts` | `Replica`, `ReplicaHealth` (`healthy \| unhealthy \| unknown`), `ReplicaRuntime` (inFlight, latencyMs, consecFail, consecOk, lastCheckedAt), `RegistrySnapshot`. |

Also agree on: config shape (fleet size, ports, interval, hysteresis N/M), and the
JSON shape `GET /status` returns.

---

## 3. Junaid — Replica & Health track

| # | Task | Deliverable |
|---|---|---|
| A1 | **Simulated replica server** | `src/replica/server.ts` — real HTTP server: `GET /health` (returns synthetic `inFlight` + measured latency), `POST /infer` (sleeps a synthetic latency, increments/decrements in-flight). |
| A2 | **Synthetic load/latency generator** | `src/replica/synthetic.ts` — fluctuating in-flight count + latency per replica; per-replica profile config (base latency, jitter, load amplitude). |
| A3 | **Kill / revive switch** | control endpoint or signal (`POST /admin/kill`, `POST /admin/revive`) that makes `/health` start failing / recover. Binary only — no partial degradation. |
| A4 | **Fleet launcher** | `src/replica/launch.ts` — spawn N replica processes (default 4) on consecutive ports from config; clean shutdown. |
| A5 | **Health scheduler module** | `src/health/scheduler.ts` — polls every registered replica every 1s via the adapter; per-replica hysteresis state machine (N consecutive fails → `unhealthy`, M consecutive OK → `healthy`); emits transition events; written as a self-contained module (extractable to its own service later). |
| A6 | **HTTP adapter impl** | `src/adapter/http.ts` — implements J1's interface against the real replica servers. |
| A7 | **Unit tests** | replica synthetic generator; scheduler state machine with fake timers (fail→unhealthy after exactly N, recover after exactly M, no flap on alternating results). |

---

## 4. Arundhati — Registry & Service track

| # | Task | Deliverable |
|---|---|---|
| B1 | **Repo scaffold** | `package.json`, `tsconfig.json`, ESLint + Prettier, `src/` layout, npm scripts (`dev`, `build`, `test`, `start:fleet`), `.gitignore`, test runner (vitest). |
| B2 | **Service registry module** | `src/registry/registry.ts` — in-memory map keyed by replicaId; `register()`, `updateRuntime()`, `setHealth()`, `getSnapshot()`; emits nothing, pure state. |
| B3 | **Registry interface + Redis stub** | `src/registry/types.ts` interface; `src/registry/redis.ts` stub implementing the same interface, throwing "not implemented" — proves the seam without wiring Redis. |
| B4 | **`GET /status` endpoint** | `src/api/server.ts` — Express server exposing the full `RegistrySnapshot` as JSON (agreed shape from §2). |
| B5 | **Config loader** | `src/config.ts` — fleet size, port range, health interval, hysteresis N/M, from env with sane defaults (4 replicas, 1s, N=3, M=2 as starting point). |
| B6 | **Unit tests** | registry (register/update/snapshot correctness, health transitions persist); `/status` returns well-formed snapshot for a seeded registry. |

---

## 5. Joint tasks (pair or split evenly)

| # | Task | Split |
|---|---|---|
| J3 | **Main process wiring** — `src/main.ts`: load config → start fleet → construct registry → register replicas → start scheduler → scheduler writes into registry on each poll → start `/status`. This is the integration point; write it together. | pair |
| J4 | **Integration test** — `test/integration/m1.test.ts`: boot fleet + main, assert registry populates within 2s, `POST /admin/kill` one replica, assert `/status` shows it `unhealthy` within (N+1)s, revive, assert recovery. | pair |
| J5 | **README + M1 demo script** | Junaid: replica/health/fault-injection sections. Arundhati: setup/scaffold/registry/status sections. |
| J6 | **M1 architecture review** — walk the seam, confirm no routing/MCP assumptions leaked in, sign off before M2. | both |

---

## 6. Sequencing

1. **Day 1:** J1 + J2 shared contract (together). Arundhati starts B1 scaffold in parallel.
2. **Day 2–3:** Junaid A1–A4 (replicas), Arundhati B2–B5 (registry + status + config). Independent, no blocking.
3. **Day 3–4:** Junaid A5–A6 (scheduler + adapter), Arundhati B6 tests. Junaid A7 tests.
4. **Day 4–5:** J3 wiring together → J4 integration test together.
5. **Day 5:** J5 docs (split), J6 review.

Only hard dependency: A5 (scheduler) and J3 (wiring) need J1/J2 done. Everything
else runs in parallel from Day 1.

---

## 7. Effort balance check

| | Junaid | Arundhati |
|---|---|---|
| Shared design authoring | J1 adapter interface | J2 domain types |
| Large module | replica server + synthetic + kill (A1–A3) | service registry + Redis-stub seam (B2–B3) |
| Large module | health scheduler + hysteresis (A5) | `/status` API + config loader (B4–B5) |
| Small module | fleet launcher (A4), HTTP adapter (A6) | repo scaffold + tooling (B1) |
| Tests | own modules (A7) | own modules (B6) |
| Joint | J3 wiring, J4 integration test, J5 docs, J6 review — evenly split | same |

Each side: one interface to author, two substantial modules, one small module,
own unit tests, half of every joint task. Balanced.

---

## 8. Working agreement

The commit / branch / PR / review rules live in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
at the repo root — they're project-wide, not M1-specific. They were in force for
all of M1.

---

## 9. Definition of done (M1)

- `npm run start:fleet` brings up 4 simulated replica servers on separate ports.
- `npm run dev` starts the main process; within ~2s `GET /status` returns all 4
  replicas as `healthy` with live in-flight/latency numbers.
- Killing a replica flips it to `unhealthy` in `/status` within (N+1) health
  intervals; reviving flips it back after M successes.
- No flapping on an alternating pass/fail replica.
- Unit + integration tests green in CI (GitHub Actions: install, build, test).
- README documents setup, run, and the kill/revive demo.
- Both authors have signed off in the architecture review.
