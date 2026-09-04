/**
 * Routing strategy contract (K1, M2).
 *
 * Drafted solo against docs/milestones/m2/task-split.md section 2, pending
 * Arundhati's review — the interface is deliberately small so both tracks can
 * build against it without waiting on each other.
 *
 * A strategy is a pure function: given the set of healthy candidates and the
 * current scoring weights, return the id of the replica to route to, or `null`
 * if there is nothing to pick from. No I/O, no adapter calls, no registry
 * access — the engine (K9) is what wires this to the real world.
 */

import type { ReplicaState } from "../types.js";

/** Live-tunable weights for strategies that blend load and latency (K5). */
export interface ScoringWeights {
  /** Weight applied to a candidate's in-flight count. */
  loadWeight: number;
  /** Weight applied to a candidate's last measured latency, in ms. */
  latencyWeight: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  loadWeight: 1,
  latencyWeight: 1,
};

export type StrategyName = "round-robin" | "least-loaded" | "latency-weighted";

export interface RoutingStrategy {
  readonly name: StrategyName;
  /**
   * Pick a replica id from `candidates` (already filtered to `healthy` by the
   * engine). Returns `null` when `candidates` is empty. A strategy never
   * mutates `candidates` or anything on them.
   */
  pick(candidates: ReplicaState[], weights: ScoringWeights): string | null;
}
