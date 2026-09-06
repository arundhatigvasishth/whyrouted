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
import type { RoutingStrategy } from "../types.js";

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
  };
}
