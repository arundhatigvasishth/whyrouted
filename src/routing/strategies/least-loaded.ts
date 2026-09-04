/**
 * Least-loaded strategy (K4).
 *
 * Picks the healthy candidate with the lowest in-flight count. Ties are broken
 * by replica id so the pick is deterministic and testable, not "whichever the
 * array happened to put first".
 */

import type { ReplicaState } from "../../types.js";
import type { RoutingStrategy } from "../types.js";

export function createLeastLoaded(): RoutingStrategy {
  return {
    name: "least-loaded",

    pick(candidates: ReplicaState[]): string | null {
      if (candidates.length === 0) return null;

      let best = candidates[0]!;
      for (const candidate of candidates.slice(1)) {
        const better =
          candidate.runtime.inFlight < best.runtime.inFlight ||
          (candidate.runtime.inFlight === best.runtime.inFlight && candidate.id < best.id);
        if (better) best = candidate;
      }
      return best.id;
    },
  };
}
