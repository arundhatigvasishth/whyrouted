/**
 * `set_scoring_weights` (P14, M5b).
 *
 * Retunes the live scoring weights. Result shape and rules fixed by
 * docs/milestones/m5b/shared-contract.md, P3.
 *
 * Two things worth knowing, both surfaced to the caller rather than hidden:
 *
 *   - Only `latency-weighted` reads the weights. `least-loaded` (the default)
 *     and `round-robin` ignore them, so a successful call under either changes
 *     nothing the router does. The result carries a note saying so, so a
 *     success is not mistaken for an effective change.
 *   - The weights are validated by `RoutingConfig`'s own rule (finite, >= 0)
 *     before anything is written. A rejected value is `invalid_input` and the
 *     stored weights are untouched.
 */

import { z } from "zod";
import { assertValidWeights } from "../../routing/config.js";
import type { RoutingConfig, ScoringWeights } from "../../routing/types.js";
import { defineActionTool, type ActionToolDefinition } from "../server.js";

export function createSetScoringWeightsTool(config: RoutingConfig): ActionToolDefinition {
  return defineActionTool({
    name: "set_scoring_weights",
    description:
      "Retune the live scoring weights: load_weight on in-flight count and latency_weight on measured latency, both finite numbers >= 0. Only the latency-weighted strategy uses them. Returns the weights before and after, read back from the router's config.",
    inputSchema: {
      load_weight: z.number().describe("Weight on in-flight request count, >= 0"),
      latency_weight: z.number().describe("Weight on measured latency in ms, >= 0"),
    },
    handler: ({ load_weight, latency_weight }) => {
      const next: ScoringWeights = { loadWeight: load_weight, latencyWeight: latency_weight };
      try {
        assertValidWeights(next);
      } catch (err) {
        return {
          kind: "invalid_input" as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      const before: ScoringWeights = config.getWeights();
      config.setWeights(next);
      const after: ScoringWeights = config.getWeights();

      const active = config.getStrategyName();
      const notes =
        active === "latency-weighted"
          ? undefined
          : [
              `the active strategy is ${active}, which does not use scoring weights: they are stored but have no effect until latency-weighted is active`,
            ];
      return { kind: "applied" as const, before, after, ...(notes && { notes }) };
    },
  });
}
