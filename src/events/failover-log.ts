/**
 * In-memory failover event store (L12, M3).
 *
 * Implements the `FailoverLog` contract (L3). Fed two ways, per
 * docs/milestones/m3/shared-contract.md, "How it is fed":
 *   - Health-check-driven transitions arrive through `handleTransition`,
 *     wired to `HealthScheduler.onTransition` in `main.ts` (L16). A
 *     transition that carries a `reason` came from `eject()` (a
 *     request-driven ejection, L2) and is skipped here, because the retry
 *     loop (L11) already recorded it directly with `trigger:
 *     "request_failure"` — recording it again on the transition would
 *     double it.
 *   - Request-driven ejections are recorded directly by the retry loop via
 *     `record()`.
 *
 * Storage is in-memory and unbounded for M3: a demo-scale fleet produces a
 * handful of events. Persistence and a retention cap are M4 / M5 concerns.
 */

import type { HealthTransition } from "../health/scheduler.js";
import type { FailoverEvent, FailoverLog } from "./types.js";

export interface FailoverLogOptions {
  /** N — folded into the synthesized reason for a poll-driven ejection. */
  unhealthyThreshold: number;
  /** M — folded into the synthesized reason for a poll-driven recovery. */
  healthyThreshold: number;
  /** Id generator, injectable for tests. Defaults to `crypto.randomUUID()`. */
  makeId?: () => string;
}

/** `FailoverLog` plus the health-scheduler wiring (L12). */
export interface FailoverLogStore extends FailoverLog {
  /**
   * Feed a `HealthScheduler` transition. Records a `health_check`-triggered
   * event for a transition to `unhealthy` or `healthy`; skips a transition
   * that carries a `reason` (that is an `eject()`, already recorded by the
   * retry loop) and a transition to `unknown` (never emitted by the
   * scheduler, not a case).
   */
  handleTransition(transition: HealthTransition): void;
}

export function createFailoverLog(opts: FailoverLogOptions): FailoverLogStore {
  const events: FailoverEvent[] = [];
  const makeId = opts.makeId ?? (() => crypto.randomUUID());

  return {
    record(event: FailoverEvent): void {
      events.push(event);
    },

    query(range: { from?: string; to?: string }): FailoverEvent[] {
      return events
        .filter(
          (e) =>
            (range.from === undefined || e.at >= range.from) &&
            (range.to === undefined || e.at <= range.to),
        )
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    },

    handleTransition(transition: HealthTransition): void {
      if (transition.reason !== undefined) return;

      if (transition.to === "unhealthy") {
        events.push({
          id: makeId(),
          replicaId: transition.replicaId,
          kind: "ejected",
          at: transition.at,
          trigger: "health_check",
          reason: `${opts.unhealthyThreshold} consecutive failed probes`,
        });
      } else if (transition.to === "healthy") {
        events.push({
          id: makeId(),
          replicaId: transition.replicaId,
          kind: "recovered",
          at: transition.at,
          trigger: "health_check",
          reason: `${opts.healthyThreshold} consecutive healthy probes`,
        });
      }
    },
  };
}
