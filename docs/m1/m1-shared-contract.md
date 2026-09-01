# M1 Shared Contract (J1 + J2) — DRAFT for sign-off

**Status:** draft by Junaid, awaiting joint sign-off with Arundhati
**Covers:** the adapter interface (J1), the shared domain types (J2), the config
shape, and the `GET /status` response shape — everything both tracks build against.

Once signed off: Junaid lands `src/adapter/types.ts`, Arundhati lands `src/types.ts`,
then the two tracks split off in parallel.

---

## J2 — Shared domain types (`src/types.ts`, owned by Arundhati)

```ts
/** Health state of a replica, as decided by the health scheduler's hysteresis. */
export type ReplicaHealth = "healthy" | "unhealthy" | "unknown";

/** Static identity of a replica — known at fleet startup, never changes. */
export interface Replica {
  id: string;   // stable, e.g. "replica-1"
  url: string;  // base URL, e.g. "http://127.0.0.1:8001"
}

/** Everything about a replica that changes over time. Owned by the registry,
 *  written by the health scheduler on each poll. */
export interface ReplicaRuntime {
  health: ReplicaHealth;
  inFlight: number;               // replica's self-reported in-flight count
  latencyMs: number | null;       // last health-probe round-trip; null before first probe
  consecFailures: number;         // consecutive failed probes (resets on success)
  consecSuccesses: number;        // consecutive successful probes (resets on failure)
  lastCheckedAt: string | null;   // ISO 8601; null before first probe
}

/** A replica plus its live runtime — the unit the registry stores and /status returns. */
export interface ReplicaState extends Replica {
  runtime: ReplicaRuntime;
}

/** Full point-in-time view of the fleet. This IS the GET /status response body. */
export interface RegistrySnapshot {
  generatedAt: string;        // ISO 8601, when the snapshot was taken
  replicas: ReplicaState[];
}
```

**Initial runtime** (when a replica is first registered, before any probe):
`{ health: "unknown", inFlight: 0, latencyMs: null, consecFailures: 0, consecSuccesses: 0, lastCheckedAt: null }`

---

## J1 — Adapter interface (`src/adapter/types.ts`, owned by Junaid)

The routing engine and health scheduler talk to replicas through exactly these two
methods (PRD §6). M1 ships the `http` implementation (A6); Phase 2 swaps in a real
one behind the same interface.

```ts
export interface HealthResult {
  alive: boolean;      // did the replica answer a health probe successfully?
  latencyMs: number;   // measured round-trip of the probe (= timeout value on failure)
  inFlight: number;    // replica's self-reported in-flight count (0 on failure)
}

export interface SendResult {
  response: unknown;   // opaque passthrough of the replica's response body
  latencyMs: number;   // measured round-trip of the request
}

export interface ReplicaAdapter {
  /** Probe one replica. NEVER rejects — a dead/unreachable replica resolves
   *  with { alive: false, latencyMs: <timeout>, inFlight: 0 }. */
  checkHealth(replicaId: string): Promise<HealthResult>;

  /** Send an inference request to one replica. REJECTS on transport failure,
   *  timeout, or non-2xx response. (No caller uses this until M2's router.) */
  sendRequest(replicaId: string, payload: unknown): Promise<SendResult>;
}
```

**id → url resolution:** the interface is `replicaId`-based per the PRD. How an id
maps to a URL is an implementation detail of `src/adapter/http.ts` — it's
constructed with the `Replica[]` list (or an `id→url` map) from config. No caller
needs to know URLs.

---

## Config shape (`src/config.ts`, owned by Arundhati — B5)

Agreed here, implemented in B5. Loaded from env with these defaults; `main.ts` (J3)
assembles it and passes narrow slices down (the scheduler gets the thresholds and
interval, the adapter gets the replica list — no module imports the whole `Config`).

```ts
export interface Config {
  host: string;              // default "127.0.0.1"
  fleetSize: number;         // default 4
  basePort: number;          // default 8001 — replicas on basePort .. basePort+fleetSize-1
  statusPort: number;        // default 8080 — where GET /status listens
  healthIntervalMs: number;  // default 1000
  healthTimeoutMs: number;   // default 500  (must be < healthIntervalMs)
  unhealthyThreshold: number; // N: consecutive failures to mark unhealthy — default 3
  healthyThreshold: number;   // M: consecutive successes to recover — default 2
}
```

Env var names: `WR_HOST`, `WR_FLEET_SIZE`, `WR_BASE_PORT`, `WR_STATUS_PORT`,
`WR_HEALTH_INTERVAL_MS`, `WR_HEALTH_TIMEOUT_MS`, `WR_UNHEALTHY_THRESHOLD`,
`WR_HEALTHY_THRESHOLD`.

Derived: the fleet is `Replica[]` = `[{ id: "replica-1", url: "http://{host}:{basePort}" }, ...]`.

---

## `GET /status` response

Body is a `RegistrySnapshot` verbatim, `200 OK`, `application/json`. Example:

```json
{
  "generatedAt": "2026-09-01T16:20:00.000Z",
  "replicas": [
    {
      "id": "replica-1",
      "url": "http://127.0.0.1:8001",
      "runtime": {
        "health": "healthy",
        "inFlight": 3,
        "latencyMs": 12,
        "consecFailures": 0,
        "consecSuccesses": 5,
        "lastCheckedAt": "2026-09-01T16:19:59.500Z"
      }
    },
    {
      "id": "replica-2",
      "url": "http://127.0.0.1:8002",
      "runtime": {
        "health": "unhealthy",
        "inFlight": 0,
        "latencyMs": 500,
        "consecFailures": 4,
        "consecSuccesses": 0,
        "lastCheckedAt": "2026-09-01T16:19:59.500Z"
      }
    }
  ]
}
```

---

## Simulated replica HTTP surface (informs A1–A3, not part of J1/J2)

Listed here so both sides agree what the replica exposes. Junaid builds it in A1–A3.

| Method + path | Purpose |
|---|---|
| `GET /health` | `200 { "inFlight": <n> }` when up; connection refused / non-2xx when killed |
| `POST /infer` | sleeps a synthetic latency, bumps in-flight for the duration, returns `200 { "response": ... }` |
| `POST /admin/kill` | flip to failing — `/health` and `/infer` start returning 503 |
| `POST /admin/revive` | flip back to healthy |

---

## Sign-off checklist (the ~15-min joint call)

- [ ] `ReplicaHealth` values: `healthy | unhealthy | unknown` — agreed?
- [ ] `checkHealth` **always resolves** (never rejects); failure → `{ alive: false, latencyMs: timeout, inFlight: 0 }` — agreed?
- [ ] `sendRequest` **rejects** on failure — agreed? (nobody calls it in M1 anyway)
- [ ] `response: unknown` passthrough (not typed) for M1 — agreed?
- [ ] `latencyMs` / `lastCheckedAt` nullable before first probe — agreed?
- [ ] Ports: replicas `8001+`, status `8080` — agreed?
- [ ] Thresholds: N = 3, M = 2 as starting values (tuned for real at M3) — agreed?
- [ ] Modules take narrow options objects; only `main.ts` sees the whole `Config` — agreed?

Anything that changes here, edit in this doc during the call so the landed files
match. Then: Junaid → `src/adapter/types.ts`, Arundhati → `src/types.ts`.
