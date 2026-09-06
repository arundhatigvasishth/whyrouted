/**
 * Routing engine (K2 contract + K9 implementation, M2).
 *
 * See docs/milestones/m2/shared-contract.md for the full agreement. The
 * interface region below (RouteResult, RoutingEngineDeps, RoutingEngine) is the
 * signed-off contract and does not change without a PR that also updates that
 * doc. `createRoutingEngine` at the bottom is the K9 implementation.
 *
 * The engine is the one piece that touches both tracks: it reads a fresh
 * registry snapshot on every `route()` call (no caching), filters to
 * `healthy`, and delegates the pick to whichever `RoutingStrategy` the active
 * `RoutingConfig` names, rebuilding that strategy instance only when the name
 * changes, per the lifecycle rule in types.ts.
 */

import type { RegistryStore } from "../registry/types.js";
import type { RoutingConfig, RoutingStrategy, StrategyName } from "./types.js";
import { createStrategy } from "./strategies/index.js";

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
   *   `no_healthy_replicas` because it is not true that the fleet is down,
   *   K11's `POST /route` must not report the same 503 body for both.
   */
  route(): RouteResult;
}

/**
 * Build a routing engine (K9).
 *
 * Stateless per call except for one thing: it holds the current strategy
 * instance so a stateful strategy (round-robin's cursor) survives across
 * requests. The instance is rebuilt only when `config.getStrategyName()`
 * returns a different name, per the lifecycle rule in types.ts.
 *
 * Everything else is read fresh on every `route()`: the registry snapshot and
 * the scoring weights, so a live config change (M5b) or a health transition
 * takes effect on the very next request with no restart.
 */
export function createRoutingEngine(deps: RoutingEngineDeps): RoutingEngine {
  let active: RoutingStrategy | undefined;

  const strategyFor = (name: StrategyName): RoutingStrategy => {
    if (active === undefined || active.name !== name) {
      active = createStrategy(name);
    }
    return active;
  };

  return {
    route(): RouteResult {
      const healthy = deps.registry
        .getSnapshot()
        .replicas.filter((replica) => replica.runtime.health === "healthy");
      if (healthy.length === 0) {
        return { ok: false, error: "no_healthy_replicas" };
      }

      const strategy = strategyFor(deps.config.getStrategyName());
      const replicaId = strategy.pick(healthy, deps.config.getWeights());
      if (replicaId === null) {
        return { ok: false, error: "no_routable_replica" };
      }

      return { ok: true, replicaId, strategy: strategy.name };
    },
  };
}
