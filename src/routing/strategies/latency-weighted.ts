/**
 * Latency-weighted strategy (K5).
 *
 * Scores each candidate as `loadWeight * inFlight + latencyWeight * latencyMs`
 * and picks the lowest score. Candidates with `latencyMs: null` (never
 * successfully probed) are excluded from scoring entirely rather than treated
 * as latency 0, so an unproven replica can't look artificially attractive.
 * Ties are broken by replica id, same as least-loaded.
 */

import type { ReplicaState } from "../../types.js";
import type { RoutingStrategy, ScoringWeights } from "../types.js";

export function createLatencyWeighted(): RoutingStrategy {
  return {
    name: "latency-weighted",

    pick(candidates: ReplicaState[], weights: ScoringWeights): string | null {
      const scoreable = candidates.filter((c) => c.runtime.latencyMs !== null);
      if (scoreable.length === 0) return null;

      const score = (c: ReplicaState): number =>
        weights.loadWeight * c.runtime.inFlight + weights.latencyWeight * c.runtime.latencyMs!;

      let best = scoreable[0]!;
      let bestScore = score(best);
      for (const candidate of scoreable.slice(1)) {
        const candidateScore = score(candidate);
        const better = candidateScore < bestScore || (candidateScore === bestScore && candidate.id < best.id);
        if (better) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      return best.id;
    },
  };
}
