# whyrouted

An inference-aware load balancer for LLM serving fleets.

**Where it's at:**

- **M1:** a simulated fleet of replicas, a health scheduler that watches them, an
  in-memory registry that tracks fleet state, and a `GET /status` endpoint that
  exposes it.
- **M2:** a routing engine with three pluggable strategies (round-robin,
  least-loaded, latency-weighted) and a `POST /route` endpoint that picks a
  healthy replica and forwards the request to it.
- **M3:** failover. A live request that fails ejects its replica immediately
  (no waiting on the health poll loop), `POST /route` retries against the
  next-best replica, and every ejection/recovery lands in a queryable
  failover log.

No decision log or MCP tools yet. `/route`'s `attempts` list explains one
request's own retries, but there's no persisted, queryable "why did this
routing decision happen" record across requests. That's M4.

---

## Requirements

- Node.js >= 20

## Setup

```
npm install
```

## Running it

```
npm run dev
```

This boots the whole system in one process:

1. Reads config from environment variables (defaults work out of the box).
2. Spawns a fleet of 4 simulated replica servers, each its own process, on
   ports `8001` to `8004`.
3. Waits for all of them to come up.
4. Registers them in the in-memory registry.
5. Starts the health scheduler, which polls every replica every second.
6. Builds the routing engine over the registry and the live routing config.
7. Starts the API server on port `8080` (`GET /status` and `POST /route`).

Once it's running:

```
curl http://127.0.0.1:8080/status
```

returns the live state of the fleet: every replica's health, in-flight
count, and last-probe latency. For example:

```json
{
  "generatedAt": "2026-09-03T19:02:42.524Z",
  "replicas": [
    {
      "id": "replica-1",
      "url": "http://127.0.0.1:8001",
      "runtime": {
        "health": "healthy",
        "inFlight": 3,
        "latencyMs": 2,
        "consecFailures": 0,
        "consecSuccesses": 5,
        "lastCheckedAt": "2026-09-03T19:02:42.485Z"
      }
    }
  ]
}
```

Stop everything with `Ctrl+C`. It shuts the scheduler, API server, and
all replica processes down cleanly.

## Routing

```
curl -X POST http://127.0.0.1:8080/route \
  -H 'content-type: application/json' \
  -d '{"payload": {"prompt": "ping"}}'
```

The routing engine picks a healthy replica, forwards `payload` to it, and
returns the replica's response:

```json
{ "replicaId": "replica-2", "strategy": "least-loaded", "response": {}, "latencyMs": 14 }
```

The pick depends on the active strategy (`WR_ROUTING_STRATEGY`):

| Strategy | How it picks |
|---|---|
| `round-robin` | Cycles healthy replicas in registration order, ignoring load |
| `least-loaded` (default) | Lowest in-flight count, ties broken by replica id |
| `latency-weighted` | Lowest `loadWeight * inFlight + latencyWeight * latencyMs`; replicas never probed successfully are skipped |

`least-loaded` and `latency-weighted` blend load and latency by
`WR_LOAD_WEIGHT` / `WR_LATENCY_WEIGHT`. The strategy and weights are read on
every request, so they are swappable without a restart (the config setter is in
place; the MCP tools that call it live are M5b).

If no replica can be routed to on the *first* attempt, `/route` returns `503`
with either `{ "error": "no_healthy_replicas" }` (the fleet is down) or
`{ "error": "no_routable_replica" }` (replicas exist but the strategy has no
usable measurement yet).

If the chosen replica's request fails, what happens next depends on the
error: see [Failover](#failover-retry--zero-loss-demo) below.

## Config

All environment variables are optional; sane defaults are built in.

| Variable | Default | Meaning |
|---|---|---|
| `WR_HOST` | `127.0.0.1` | Host the replicas and API server bind to |
| `WR_FLEET_SIZE` | `4` | Number of simulated replicas |
| `WR_BASE_PORT` | `8001` | First replica port (fleet occupies `basePort..basePort+fleetSize-1`) |
| `WR_STATUS_PORT` | `8080` | Port the API server (`GET /status`, `POST /route`) listens on |
| `WR_HEALTH_INTERVAL_MS` | `500` | How often the scheduler polls each replica |
| `WR_HEALTH_TIMEOUT_MS` | `200` | Per-probe timeout (must be less than the interval) |
| `WR_UNHEALTHY_THRESHOLD` | `3` | Consecutive failed probes before a replica is marked `unhealthy` |
| `WR_HEALTHY_THRESHOLD` | `2` | Consecutive successful probes before it recovers to `healthy` |
| `WR_ROUTING_STRATEGY` | `least-loaded` | `round-robin`, `least-loaded`, or `latency-weighted` |
| `WR_LOAD_WEIGHT` | `1` | Weight on in-flight count in the latency-weighted score (>= 0) |
| `WR_LATENCY_WEIGHT` | `1` | Weight on measured latency in the latency-weighted score (>= 0) |
| `WR_MAX_RETRIES` | `2` | Retries `POST /route` makes against the next-best replica on a retryable failure (3 attempts total). `0` disables retry |

## Fault-injection demo (kill / revive)

Each simulated replica has two admin endpoints for manually forcing it to
fail, so you can watch the health scheduler and `/status` react in real time.

With `npm run dev` running in one terminal:

```
# kill replica-1: it starts failing every request with 503
curl -X POST http://127.0.0.1:8001/admin/kill

# watch it flip to unhealthy after WR_UNHEALTHY_THRESHOLD (default 3)
# consecutive failed health checks
curl http://127.0.0.1:8080/status

# bring it back
curl -X POST http://127.0.0.1:8001/admin/revive

# watch it recover to healthy after WR_HEALTHY_THRESHOLD (default 2)
# consecutive successful checks
curl http://127.0.0.1:8080/status
```

The other replicas are unaffected. Only the one you kill changes state.
Recovery isn't instant on either side; it takes the configured number of
consecutive probes in a row (that's the hysteresis that stops one flaky
check from flapping a replica in and out of rotation).

Once a killed replica is `unhealthy`, `POST /route` stops picking it. Send a
few `/route` calls after the kill and you'll see every response come back from
one of the survivors.

### Infer-only failure (for testing request-driven ejection)

`/admin/kill` fails both `/health` and `/infer`, so the health scheduler is
what ejects the replica, 1.5s worst case at the defaults. To see the *other*
failover path, request-driven ejection (M3): a live request fails immediately
against a replica whose health checks are still passing.

```
# replica-1's /health still returns 200; only /infer starts failing
curl -X POST http://127.0.0.1:8001/admin/fail-infer

# /status still shows replica-1 healthy right after this
curl http://127.0.0.1:8080/status

# a single /admin/revive clears either fault mode
curl -X POST http://127.0.0.1:8001/admin/revive
```

## Failover (retry + zero-loss demo)

A failed request no longer just fails. `POST /route` classifies the error and
reacts:

- **Retryable** (timeout, connection refused, or a 5xx): the replica is
  ejected immediately (no waiting for the health poll), the failure is
  recorded in the failover log, and the request retries against the
  next-best replica, up to `WR_MAX_RETRIES` times.
- **Not retryable** (a 4xx): the replica isn't at fault, so it's not ejected.
  `/route` returns `502 { "error": "replica_request_failed", replicaId,
  detail, attempts }` right away.
- **Retries exhausted**: `503 { "error": "all_replicas_failed", attempts }`.

A successful response always carries `attempts`, the ordered list of failed
tries before the one that worked (`[]` on a first-try success):

```json
{
  "replicaId": "replica-2",
  "strategy": "least-loaded",
  "response": {},
  "latencyMs": 14,
  "attempts": [{ "replicaId": "replica-1", "kind": "timeout" }]
}
```

**Try it**: with `npm run dev` running, fail a replica mid-request and watch
`/route` route around it without ever failing to the client:

```
# fail replica-1's live requests only (health checks stay green)
curl -X POST http://127.0.0.1:8001/admin/fail-infer

# every one of these succeeds, served by a survivor
for i in 1 2 3; do
  curl -X POST http://127.0.0.1:8080/route \
    -H 'content-type: application/json' \
    -d '{"payload": {"prompt": "ping"}}'
done

curl -X POST http://127.0.0.1:8001/admin/revive
```

`test/integration/m3.test.ts` automates a stronger version of this: continuous
load through a real kill and revive, asserting zero client-visible failures,
sub-1s failover detection (measured from the failover log's own timestamps),
and hysteresis-gated recovery, matching the PRD's failover success metrics.

## Running the fleet standalone

To run just the simulated replicas without the rest of the system (e.g. for
manually poking at one with `curl`):

```
npm run start:fleet
```

## Tests

```
npm test
```

Runs unit tests for every module plus three integration tests, no mocks:

- `test/integration/m1.test.ts` boots the real system as a child process and
  drives the kill/revive arc from the manual demo above, asserting the fleet
  reaches `healthy`, a kill shows up as `unhealthy` in `/status`, and a revive
  recovers it.
- `test/integration/m2.test.ts` (also a child process) sends `POST /route`
  traffic under each strategy and asserts the routing pattern holds
  (round-robin cycles, least-loaded concentrates on the lightest replica),
  then kills a replica and asserts it drops out of the routing candidates.
- `test/integration/m3.test.ts` builds the system in-process (so it can assert
  on the failover log directly) and drives continuous `POST /route` load
  through a real kill/revive, asserting zero client-visible failures, sub-1s
  detection via request-driven ejection, and hysteresis-gated recovery.

## Project structure

```
src/
  adapter/    interface + HTTP implementation for talking to replicas
  api/        GET /status and POST /route server (retry loop added M3)
  events/     failover event log (ejections + recoveries, queryable by time)
  health/     health scheduler (hysteresis-based health state machine + eject)
  registry/   in-memory fleet state store (+ Redis stub for later)
  replica/    simulated replica server, fleet launcher, synthetic load
  routing/    routing engine, strategies, live strategy/weight config
  config.ts   env-based config loader
  types.ts    shared domain types
  main.ts     wires everything together
test/
  integration/  end-to-end system tests (one per milestone)
  *.test.ts     unit tests, one per module
docs/
  prd.md            product spec
  architecture/     design record, one review per milestone
  decisions.md      load-bearing technical decisions + rationale
  milestones/       per-milestone planning (task splits, idea docs)
```

See [`docs/README.md`](docs/README.md) for what's what.
