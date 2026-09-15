/**
 * Failover event record (L3, M3).
 *
 * The queryable timeline of every ejection and recovery. This is **not** the
 * M4 decision log (that is per-request routing rationale); it is the
 * substrate M5a's `get_failover_history(time_range)` reads. Shape fixed by
 * docs/milestones/m3/shared-contract.md, "L3: Failover event record".
 */

export interface FailoverEvent {
  /** Unique id, `crypto.randomUUID()`. */
  id: string;
  replicaId: string;
  kind: "ejected" | "recovered";
  /** ISO 8601, from the triggering transition. */
  at: string;
  trigger: "health_check" | "request_failure";
  /** Human-readable cause, always populated (synthesized for poll-driven events). */
  reason: string;
  /** The request whose failure caused a `request_failure` ejection. Absent otherwise. */
  requestId?: string;
}

export interface FailoverLog {
  record(event: FailoverEvent): void;
  /** Events with `from <= at <= to`, both bounds optional and inclusive, ascending by `at`. */
  query(range: { from?: string; to?: string }): FailoverEvent[];
}
