# whyrouted

An inference-aware load balancer for LLM serving fleets.

**M1 scope:** a simulated fleet of replicas, a health scheduler that watches
them, an in-memory registry that tracks fleet state, and a `GET /status`
endpoint that exposes it. No routing yet. That's M2.

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

This boots the whole M1 system in one process:

1. Reads config from environment variables (defaults work out of the box).
2. Spawns a fleet of 4 simulated replica servers, each its own process, on
   ports `8001` to `8004`.
3. Waits for all of them to come up.
4. Registers them in the in-memory registry.
5. Starts the health scheduler, which polls every replica every second.
6. Starts the status server on port `8080`.

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

Stop everything with `Ctrl+C`. It shuts the scheduler, status server, and
all replica processes down cleanly.

## Config

All environment variables are optional; sane defaults are built in.

| Variable | Default | Meaning |
|---|---|---|
| `WR_HOST` | `127.0.0.1` | Host the replicas and status server bind to |
| `WR_FLEET_SIZE` | `4` | Number of simulated replicas |
| `WR_BASE_PORT` | `8001` | First replica port (fleet occupies `basePort..basePort+fleetSize-1`) |
| `WR_STATUS_PORT` | `8080` | Port `GET /status` listens on |
| `WR_HEALTH_INTERVAL_MS` | `1000` | How often the scheduler polls each replica |
| `WR_HEALTH_TIMEOUT_MS` | `500` | Per-probe timeout (must be less than the interval) |
| `WR_UNHEALTHY_THRESHOLD` | `3` | Consecutive failed probes before a replica is marked `unhealthy` |
| `WR_HEALTHY_THRESHOLD` | `2` | Consecutive successful probes before it recovers to `healthy` |

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

Runs unit tests for every module plus the M1 integration test
(`test/integration/m1.test.ts`), which boots the real system as a child
process and drives the same kill/revive arc as the manual demo above,
asserting the fleet reaches `healthy`, a kill shows up as `unhealthy` in
`/status`, and a revive recovers it, end to end, no mocks.

## Project structure

```
src/
  adapter/    interface + HTTP implementation for talking to replicas
  api/        GET /status server
  health/     health scheduler (hysteresis-based health state machine)
  registry/   in-memory fleet state store (+ Redis stub for later)
  replica/    simulated replica server, fleet launcher, synthetic load
  config.ts   env-based config loader
  types.ts    shared domain types
  main.ts     wires everything together
test/
  integration/  end-to-end system test
  *.test.ts     unit tests, one per module
docs/
  prd.md            product spec
  architecture/     design record, one review per milestone
  decisions.md      load-bearing technical decisions + rationale
  milestones/       per-milestone planning (task splits, idea docs)
```

See [`docs/README.md`](docs/README.md) for what's what.
