/**
 * Round-robin strategy (K3).
 *
 * Cycles healthy candidates in registration order, ignoring load and latency
 * entirely. The baseline strategy: useful as a control to compare the
 * load-aware strategies against.
 */

import type { ReplicaState } from "../../types.js";
import type { RoutingStrategy } from "../types.js";

export function createRoundRobin(): RoutingStrategy {
  /** Index of the last-picked candidate's id in the *full* fleet order. */
  let cursor = 0;

  return {
    name: "round-robin",

    pick(candidates: ReplicaState[]): string | null {
      if (candidates.length === 0) return null;
      const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
      const chosen = sorted[cursor % sorted.length]!;
      cursor += 1;
      return chosen.id;
    },
  };
}
