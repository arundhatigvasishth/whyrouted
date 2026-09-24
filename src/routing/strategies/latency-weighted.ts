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
import type { CandidateScore, RoutingStrategy, ScoringWeights } from "../types.js";

const scoreOf = (c: ReplicaState, weights: ScoringWeights): number =>
  weights.loadWeight * c.runtime.inFlight + weights.latencyWeight * c.runtime.latencyMs!;

export function createLatencyWeighted(): RoutingStrategy {
  return {
    name: "latency-weighted",

    pick(candidates: ReplicaState[], weights: ScoringWeights): string | null {
      const scoreable = candidates.filter((c) => c.runtime.latencyMs !== null);
      if (scoreable.length === 0) return null;

      let best = scoreable[0]!;
      let bestScore = scoreOf(best, weights);
      for (const candidate of scoreable.slice(1)) {
        const candidateScore = scoreOf(candidate, weights);
        const better =
          candidateScore < bestScore || (candidateScore === bestScore && candidate.id < best.id);
        if (better) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      return best.id;
    },

    // A candidate with latencyMs: null is excluded from scoring entirely,
    // same as pick(): an unproven replica can't look artificially
    // attractive, and it can't be ranked without a real measurement. Not an
    // ExcludedCandidate (N3): the engine never filtered it, the strategy
    // itself declined to score it. Per the shared contract (N1), this is
    // documented behaviour, not a gap in the decision record.
    score(candidates: ReplicaState[], weights: ScoringWeights): CandidateScore[] {
      return candidates
        .filter((c) => c.runtime.latencyMs !== null)
        .map((c) => ({
          replicaId: c.id,
          inFlight: c.runtime.inFlight,
          latencyMs: c.runtime.latencyMs,
          score: scoreOf(c, weights),
          considered: true,
        }));
    },
  };
}
