/**
 * Strategy registry (K6).
 *
 * Maps a strategy name to its implementation. Used by the engine (K9) to
 * resolve the currently configured strategy, and later by the
 * `set_routing_strategy` MCP tool (M5b) to swap it live. Throws on an unknown
 * name rather than silently falling back, so a typo in config or a tool call
 * fails loudly instead of quietly routing round-robin.
 */

import type { RoutingStrategy, StrategyName } from "../types.js";
import { createRoundRobin } from "./round-robin.js";
import { createLeastLoaded } from "./least-loaded.js";
import { createLatencyWeighted } from "./latency-weighted.js";

const factories: Record<StrategyName, () => RoutingStrategy> = {
  "round-robin": createRoundRobin,
  "least-loaded": createLeastLoaded,
  "latency-weighted": createLatencyWeighted,
};

/** Build a fresh instance of the named strategy. Throws on an unknown name. */
export function createStrategy(name: StrategyName): RoutingStrategy {
  const factory = factories[name];
  if (!factory) {
    throw new Error(`unknown routing strategy ${JSON.stringify(name)}`);
  }
  return factory();
}

export const STRATEGY_NAMES: StrategyName[] = Object.keys(factories) as StrategyName[];
