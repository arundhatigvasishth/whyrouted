# M2 Shared Contract (K1 + K2)

**Status:** drafted solo by Junaid (2026-09-04), revised after Arundhati's review
of the first draft, agreed by both (2026-09-06). K9 through K12 are built and
merged against it.
**Covers:** the routing strategy interface (K1), the engine interface, the
live strategy/weight config holder, and the `POST /route` request/response
shape, everything both tracks build against for M2.

Landed as: `src/routing/types.ts` and `src/routing/engine.ts` (Junaid),
`src/routing/config.ts` and `src/api/server.ts` (Arundhati).
Changes after sign-off go through a PR that touches both this doc and the files.

---

## K1: Strategy interface (`src/routing/types.ts`)

```ts
export interface ScoringWeights {
  loadWeight: number;     // >= 0, finite
  latencyWeight: number;  // >= 0, finite
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = { loadWeight: 1, latencyWeight: 1 };

export type StrategyName = "round-robin" | "least-loaded" | "latency-weighted";

export interface RoutingStrategy {
  readonly name: StrategyName;
  pick(candidates: ReplicaState[], weights: ScoringWeights): string | null;
}
```

**Strategy rules:**
- No I/O, no adapter calls, no registry access.
- Never mutates `candidates` or anything on them.
- **May keep internal state across calls** (round-robin's cursor does). Not
  required to be a pure function, just side-effect-free with respect to
  anything *outside* itself. (Revised from the first draft, which incorrectly
  called strategies pure functions.)
- `candidates` always arrive in **registry registration order**
  (`replica-1, replica-2, ...`), already filtered to `healthy` by the engine. A
  strategy may rely on that order and must not re-derive its own (round-robin
  cycles through the given order directly, no re-sort).
- Returns `null` when there's nothing to pick from: either `candidates` is
  empty, or (latency-weighted) every candidate lacks a usable measurement. A
  strategy only reports "I have nothing," it does not distinguish why; the
  engine does that (see `RouteResult` below).

**Lifecycle rule (binds the engine, K9):** the engine holds exactly one
`RoutingStrategy` instance per active strategy and only rebuilds it when the
configured strategy name changes. Calling `createStrategy` fresh on every
`route()` would reset any strategy's internal state (round-robin's cursor)
on every single request. This was the sharpest gap in the first draft.

---

## Live strategy/weight config (`RoutingConfig`, implemented in K10)

```ts
export interface RoutingConfig {
  getStrategyName(): StrategyName;
  setStrategyName(name: StrategyName): void;
  getWeights(): ScoringWeights;
  setWeights(weights: ScoringWeights): void;
}
```

A single mutable in-process object, read by the engine on every `route()` call,
written by config/MCP action tools (M5b) without a restart. `setWeights` throws
on a negative, `NaN`, or non-finite weight, and `setStrategyName` throws on an
unknown name. `DEFAULT_SCORING_WEIGHTS` lives once in `src/routing/types.ts`;
`src/config.ts` imports it rather than redeclaring `{ 1, 1 }`.

Landed as `src/routing/config.ts` (`createRoutingConfig`). Startup values come
from `src/config.ts`: `WR_ROUTING_STRATEGY` (default `least-loaded`, see
`docs/decisions.md`), `WR_LOAD_WEIGHT` and `WR_LATENCY_WEIGHT` (default `1`).

---

## K2: Engine interface (`src/routing/engine.ts`)

```ts
export type RouteResult =
  | { ok: true; replicaId: string; strategy: string }
  | { ok: false; error: "no_healthy_replicas" }
  | { ok: false; error: "no_routable_replica" };

export interface RoutingEngineDeps {
  registry: Pick<RegistryStore, "getSnapshot">;
  config: RoutingConfig;
}

export interface RoutingEngine {
  route(): RouteResult;
}
```

`RouteResult` is a tagged union (`ok: true | false`) rather than the
`{ replicaId } | { error }` shape in the first draft, so it narrows cleanly and
extends without a breaking change later (M4 will likely add a rationale field
to the success case).

**Two distinct error cases, not one:**
- `no_healthy_replicas`: the registry has no replica in `healthy` state.
- `no_routable_replica`: there were healthy candidates, but the active
  strategy still couldn't pick one (e.g. latency-weighted with no candidate
  that has a latency measurement yet). This is **not** the same fact as the
  fleet being down. The first draft conflated the two, which would have made
  K11's `POST /route` return a misleading 503 body.

**Engine deps** mirror the M1 pattern of narrowing a dependency to exactly
what's used (see `HealthSink` in `src/health/scheduler.ts`): the engine only
ever reads the registry (`getSnapshot`), never writes to it.

**Not frozen:** `route()` takes no request context in M2 (no session/affinity
routing). Request-aware routing (M4+) will likely change this signature, so
callers shouldn't assume it's permanent.

---

## `POST /route` request/response shape

Landed as `POST /route` in `src/api/server.ts`.

Request body: `{ "payload": <opaque, forwarded to sendRequest as-is> }`. A missing
`payload` is allowed and forwards `undefined` (the adapter sends `{}`).

Success, `200`:
```json
{ "replicaId": "replica-2", "strategy": "least-loaded", "response": {}, "latencyMs": 14 }
```
`response` is the adapter's opaque `SendResult.response` passthrough; `latencyMs`
is the adapter's measured round-trip for the forwarded request, not the
engine's routing overhead.

No routable replica, `503`:
```json
{ "error": "no_healthy_replicas" }
```
or
```json
{ "error": "no_routable_replica" }
```
The engine's two error variants pass straight through, unchanged, so the caller
can tell "fleet is down" from "nothing routable yet".

The chosen replica's request failed, `502` (the engine picked a healthy replica
but `sendRequest` rejected: transport error, timeout, or non-2xx). M2 has no
failover, that is M3, so this is terminal for the request:
```json
{ "error": "replica_request_failed", "replicaId": "replica-3", "detail": "..." }
```

Malformed JSON body, `400`: `{ "error": "invalid_json_body" }`.

---

## Sign-off checklist

- [x] Strategy interface shape (Junaid)
- [x] Strategy state/lifecycle rule (Junaid, addressing Arundhati's review)
- [x] `RouteResult` as a tagged union with two distinct error cases (Junaid, addressing Arundhati's review)
- [x] `RoutingConfig` holder shape (Junaid, addressing Arundhati's review)
- [x] `RoutingEngineDeps` constructor shape (Junaid, addressing Arundhati's review)
- [x] `POST /route` request/response shape (Junaid, addressing Arundhati's review)
- [x] Agreed (Arundhati, 2026-09-06): reviewed K9 through K12 as merged against
  this doc. Strategies, engine, config holder, and `/route` all conform. Two
  small follow-ups, neither blocking: `RouteResult.strategy` is typed `string`
  and could be `StrategyName`; `src/config.ts` importing `STRATEGY_NAMES` from
  the routing module pulls the strategy factories into the replica launcher's
  import graph.

Any change after sign-off goes through a PR that updates this doc and the
affected files together.
