/**
 * Routing strategy contract (K1, M2).
 *
 * See docs/milestones/m2/shared-contract.md for the full agreement this is
 * part of, including the `POST /route` JSON shape and the config holder.
 *
 * A strategy does no I/O and never touches the registry or adapter, and never
 * mutates `candidates` or anything on them. It may keep internal state across
 * calls (round-robin's cursor does): it is not required to be a pure
 * function, just side-effect-free with respect to anything outside itself.
 *
 * Lifecycle rule (binds the engine, K9): the engine holds exactly one
 * `RoutingStrategy` instance per active strategy and only rebuilds it when the
 * configured strategy name changes. Calling `createStrategy` fresh on every
 * `route()` would reset any strategy's internal state (e.g. round-robin's
 * cursor) on every single request.
 *
 * `candidates` passed to `pick` are always in registry registration order
 * (`replica-1, replica-2, ...`), already filtered to `healthy` by the engine.
 * A strategy may rely on that order; it must not need to re-derive its own.
 */

import type { ReplicaState } from "../types.js";

/** Live-tunable weights for strategies that blend load and latency (K5). */
export interface ScoringWeights {
  /** Weight applied to a candidate's in-flight count. Must be >= 0 and finite. */
  loadWeight: number;
  /** Weight applied to a candidate's last measured latency, in ms. Must be >= 0 and finite. */
  latencyWeight: number;
}

/**
 * The one place this default is defined. `src/config.ts` (K10) imports this
 * rather than redeclaring `{ 1, 1 }` itself.
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  loadWeight: 1,
  latencyWeight: 1,
};

export type StrategyName = "round-robin" | "least-loaded" | "latency-weighted";

export interface RoutingStrategy {
  readonly name: StrategyName;
  /**
   * Pick a replica id from `candidates`. Returns `null` when there is nothing
   * this strategy can pick from: either `candidates` is empty, or (for
   * latency-weighted) every candidate lacks a usable measurement. The engine
   * is responsible for telling these two `null` cases apart in `RouteResult`
   * (see engine.ts); a strategy only ever reports "I have nothing," not why.
   */
  pick(candidates: ReplicaState[], weights: ScoringWeights): string | null;
}

/**
 * Live holder for the active strategy name and scoring weights (K10). A
 * single mutable in-process object, read by the engine on every `route()`
 * call and written by config/MCP action tools (M5b) without a restart.
 *
 * `setWeights` throws on a negative, `NaN`, or non-finite weight rather than
 * silently accepting it.
 */
export interface RoutingConfig {
  getStrategyName(): StrategyName;
  setStrategyName(name: StrategyName): void;
  getWeights(): ScoringWeights;
  setWeights(weights: ScoringWeights): void;
}
