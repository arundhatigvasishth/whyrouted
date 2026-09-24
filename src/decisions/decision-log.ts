/**
 * In-memory decision log (N10, M4).
 *
 * Implements the `DecisionLog` contract (N2). Mirrors `FailoverLog`'s shape
 * (`src/events/failover-log.ts`): the caller (the `POST /route` retry loop,
 * N11) builds a fully-formed `Decision`, id included, and calls `record()`
 * with it, exactly once per client-facing request.
 *
 * Storage is in-memory and unbounded for M4, same deferral as M3's failover
 * log: a demo-scale fleet produces a handful of decisions per run. Persistence
 * (PRD §7: JSON lines -> SQLite) is an M7/M8 concern, once Docker/K8s exist to
 * manage it (docs/milestones/m4/shared-contract.md, "Not frozen").
 *
 * `get()` is a linear scan over the same backing array `query()` uses. A
 * demo-scale fleet's request volume doesn't justify an index yet; revisit if
 * that stops being true.
 */

import type { Decision, DecisionLog } from "./types.js";

export function createDecisionLog(): DecisionLog {
  const decisions: Decision[] = [];

  return {
    record(decision: Decision): void {
      decisions.push(decision);
    },

    query(range: { from?: string; to?: string }): Decision[] {
      return decisions
        .filter(
          (d) =>
            (range.from === undefined || d.at >= range.from) &&
            (range.to === undefined || d.at <= range.to),
        )
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    },

    get(requestId: string): Decision | undefined {
      return decisions.find((d) => d.requestId === requestId);
    },
  };
}
