/**
 * Round-robin strategy (K3).
 *
 * Cycles healthy candidates in the order the engine hands them over
 * (registry registration order, per the contract in
 * docs/milestones/m2/shared-contract.md), ignoring load and latency entirely.
 * The baseline strategy: useful as a control to compare the load-aware
 * strategies against.
 *
 * Trusts the given order rather than re-deriving one: the contract already
 * guarantees it, and re-sorting here would be a second, redundant source of
 * truth for something that's the engine's job.
 *
 * Keeps a cursor across calls, so the engine must reuse this same instance
 * for the lifetime of "round-robin" being the active strategy (see the
 * lifecycle rule in the contract). Rebuilding it every call would reset the
 * cursor and break the cycling.
 */

import type { ReplicaState } from "../../types.js";
import type { CandidateScore, RoutingStrategy } from "../types.js";

export function createRoundRobin(): RoutingStrategy {
  let cursor = 0;

  return {
    name: "round-robin",

    pick(candidates: ReplicaState[]): string | null {
      if (candidates.length === 0) return null;
      const chosen = candidates[cursor % candidates.length]!;
      cursor += 1;
      return chosen.id;
    },

    // Round-robin has no load- or latency-based score (N1/N6). Stand-in:
    // cyclic distance from the cursor, so the next candidate pick() would
    // return scores 0, the one after it 1, and so on, wrapping. Keeps the
    // "lower is better" convention uniform across all three strategies
    // instead of leaving a null/constant gap in the decision record.
    //
    // Reads `cursor` but never advances it: only pick() may do that, so
    // calling score() any number of times must not change what the next
    // pick() returns (N1's "also agreed" clause, checked by N7).
    score(candidates: ReplicaState[]): CandidateScore[] {
      if (candidates.length === 0) return [];
      return candidates.map((candidate, index) => ({
        replicaId: candidate.id,
        inFlight: candidate.runtime.inFlight,
        latencyMs: candidate.runtime.latencyMs,
        score: (index - (cursor % candidates.length) + candidates.length) % candidates.length,
        considered: true,
      }));
    },
  };
}
