/**
 * Routing engine contract (K2, M2).
 *
 * See docs/milestones/m2/shared-contract.md for the full agreement. Signature
 * only here; K9 implements it.
 *
 * The engine is the one piece that touches both tracks: it reads a fresh
 * registry snapshot on every `route()` call (no caching), filters to
 * `healthy`, and delegates the pick to whichever `RoutingStrategy` the active
 * `RoutingConfig` names — rebuilding that strategy instance only when the name
 * changes, per the lifecycle rule in types.ts.
 */

import type { RegistryStore } from "../registry/types.js";
import type { RoutingConfig } from "./types.js";

export type RouteResult =
  | { ok: true; replicaId: string; strategy: string }
  | { ok: false; error: "no_healthy_replicas" }
  | { ok: false; error: "no_routable_replica" };

/**
 * What the engine needs to be built, mirroring the M1 pattern of narrowing a
 * dependency to exactly the methods used (see `HealthSink` in
 * src/health/scheduler.ts). The engine only ever reads the registry.
 */
export interface RoutingEngineDeps {
  registry: Pick<RegistryStore, "getSnapshot">;
  config: RoutingConfig;
}

export interface RoutingEngine {
  /**
   * Pick a replica for the next request.
   *
   * - `no_healthy_replicas`: the registry has no replica in `healthy` state.
   * - `no_routable_replica`: there were healthy candidates, but the active
   *   strategy still couldn't pick one (e.g. latency-weighted with no
   *   candidate that has a latency measurement yet). Distinct from
   *   `no_healthy_replicas` because it is not true that the fleet is down —
   *   K11's `POST /route` must not report the same 503 body for both.
   */
  route(): RouteResult;
}
