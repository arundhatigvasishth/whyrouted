/**
 * Live routing config holder (K10, M2).
 *
 * Implements the `RoutingConfig` interface from types.ts: a single mutable
 * in-process object that holds the active strategy name and scoring weights.
 * The engine reads it on every `route()` call, so a change here takes effect
 * on the next request with no restart. M5b's `set_routing_strategy` and
 * `set_scoring_weights` MCP tools are the other writers.
 *
 * Startup values come from `src/config.ts` (env-loaded, validated there). The
 * setters re-validate because M5b feeds them values straight off the wire.
 */

import type { RoutingConfig, ScoringWeights, StrategyName } from "./types.js";
import { STRATEGY_NAMES } from "./strategies/index.js";

/** Throws unless both weights are finite and >= 0. Shared by the setter and tests. */
export function assertValidWeights(weights: ScoringWeights): void {
  for (const [key, value] of [
    ["loadWeight", weights.loadWeight],
    ["latencyWeight", weights.latencyWeight],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a finite number >= 0, got ${JSON.stringify(value)}`);
    }
  }
}

function assertValidStrategyName(name: string): asserts name is StrategyName {
  if (!(STRATEGY_NAMES as string[]).includes(name)) {
    throw new Error(
      `unknown routing strategy ${JSON.stringify(name)}, expected one of ${STRATEGY_NAMES.join(", ")}`,
    );
  }
}

export interface RoutingConfigInit {
  strategy: StrategyName;
  weights: ScoringWeights;
}

/**
 * Build the live config holder from its startup values. The returned object is
 * the single source of truth for the active strategy and weights.
 */
export function createRoutingConfig(init: RoutingConfigInit): RoutingConfig {
  assertValidStrategyName(init.strategy);
  assertValidWeights(init.weights);

  let strategyName = init.strategy;
  let weights: ScoringWeights = { ...init.weights };

  return {
    getStrategyName: () => strategyName,

    setStrategyName: (name) => {
      assertValidStrategyName(name);
      strategyName = name;
    },

    getWeights: () => ({ ...weights }),

    setWeights: (next) => {
      assertValidWeights(next);
      weights = { loadWeight: next.loadWeight, latencyWeight: next.latencyWeight };
    },
  };
}
