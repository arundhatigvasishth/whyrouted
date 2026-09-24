/**
 * Routing engine (K2 contract + K9 implementation, M2; candidate capture
 * added M4, N9).
 *
 * See docs/milestones/m2/shared-contract.md for the full M2 agreement and
 * docs/milestones/m4/shared-contract.md (N1, N3, N4) for the M4 additions.
 * The interface region below (RouteResult, RoutingEngineDeps, RoutingEngine)
 * is the signed-off contract and does not change without a PR that also
 * updates those docs. `createRoutingEngine` at the bottom is the
 * implementation.
 *
 * The engine is the one piece that touches both tracks: it reads a fresh
 * registry snapshot on every `route()` call (no caching), filters to
 * `healthy`, and delegates the pick to whichever `RoutingStrategy` the active
 * `RoutingConfig` names, rebuilding that strategy instance only when the name
 * changes, per the lifecycle rule in types.ts.
 */

import type { ReplicaState } from "../types.js";
import type { RegistryStore } from "../registry/types.js";
import type {
  CandidateScore,
  ExcludedCandidate,
  RoutingConfig,
  RoutingStrategy,
  StrategyName,
} from "./types.js";
import { createStrategy } from "./strategies/index.js";

/**
 * Fields every `route()` outcome carries (M4, N4): what the round scored and
 * excluded, and under which strategy. Present on `no_healthy_replicas` /
 * `no_routable_replica` too, not just a successful pick, so a `DecisionRound`
 * built from a failed round is never missing this data.
 */
interface RouteOutcomeCapture {
  strategy: string;
  candidates: CandidateScore[];
  excluded: ExcludedCandidate[];
}

export type RouteResult =
  | ({ ok: true; replicaId: string } & RouteOutcomeCapture)
  | ({ ok: false; error: "no_healthy_replicas" } & RouteOutcomeCapture)
  | ({ ok: false; error: "no_routable_replica" } & RouteOutcomeCapture);

/**
 * What the engine needs to be built, mirroring the M1 pattern of narrowing a
 * dependency to exactly the methods used (see `HealthSink` in
 * src/health/scheduler.ts). The engine only ever reads the registry.
 */
export interface RoutingEngineDeps {
  registry: Pick<RegistryStore, "getSnapshot">;
  config: RoutingConfig;
}

export interface RouteOptions {
  /**
   * Replica ids to leave out of the candidate pool for this call (M3, L10):
   * the retry loop's already-tried set. Filtered out of `healthy` before the
   * strategy ever sees the candidates, so `RoutingStrategy` stays ignorant of
   * failover (docs/milestones/m3/shared-contract.md, "Frozen by this contract").
   */
  exclude?: readonly string[];
}

export interface RoutingEngine {
  /**
   * Pick a replica for the next request.
   *
   * - `no_healthy_replicas`: the registry has no replica in `healthy` state.
   * - `no_routable_replica`: there were healthy candidates, but the active
   *   strategy still couldn't pick one (e.g. latency-weighted with no
   *   candidate that has a latency measurement yet), or `exclude` filtered
   *   every healthy candidate out. Distinct from `no_healthy_replicas`
   *   because it is not true that the fleet is down, K11's `POST /route`
   *   must not report the same 503 body for both.
   *
   * Every outcome, including both failure cases, also carries `strategy`,
   * `candidates`, and `excluded` (M4, N4), so a caller building a decision
   * record (M4, N11) never has to special-case a failed round.
   */
  route(opts?: RouteOptions): RouteResult;
}

/**
 * Build a routing engine (K9; candidate capture added N9).
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
    route(opts?: RouteOptions): RouteResult {
      const snapshot = deps.registry.getSnapshot().replicas;
      const healthy = snapshot.filter((replica) => replica.runtime.health === "healthy");

      // N3: every replica not in `healthy` is excluded before anything is
      // scored, and never reaches a strategy.
      const excluded: ExcludedCandidate[] = snapshot
        .filter((replica) => replica.runtime.health !== "healthy")
        .map((replica) => ({ replicaId: replica.id, reason: "unhealthy" as const }));

      if (healthy.length === 0) {
        // No strategy is looked up here at all (N4): `strategy` names the
        // configured one, not one that scored anything this round.
        return {
          ok: false,
          error: "no_healthy_replicas",
          strategy: deps.config.getStrategyName(),
          candidates: [],
          excluded,
        };
      }

      const exclude = opts?.exclude;
      const pool: ReplicaState[] = [];
      for (const replica of healthy) {
        if (exclude !== undefined && exclude.includes(replica.id)) {
          excluded.push({ replicaId: replica.id, reason: "already_tried" });
        } else {
          pool.push(replica);
        }
      }

      const strategy = strategyFor(deps.config.getStrategyName());
      const weights = deps.config.getWeights();
      // N4 step 3: score() runs on the pool even when it is empty, on the
      // same snapshot pick() is about to use, no re-read in between.
      const candidates = strategy.score(pool, weights);

      if (pool.length === 0) {
        return {
          ok: false,
          error: "no_routable_replica",
          strategy: strategy.name,
          candidates,
          excluded,
        };
      }

      const replicaId = strategy.pick(pool, weights);
      if (replicaId === null) {
        return {
          ok: false,
          error: "no_routable_replica",
          strategy: strategy.name,
          candidates,
          excluded,
        };
      }

      return { ok: true, replicaId, strategy: strategy.name, candidates, excluded };
    },
  };
}
