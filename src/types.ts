/**
 * Shared domain types for whyrouted (J2).
 *
 * The common vocabulary both tracks build against: what a replica is, what its
 * health and live stats look like, and the exact shape `GET /status` returns.
 * Signed off jointly in docs/m1/m1-shared-contract.md before either track
 * started. No behaviour here — types plus one factory for the initial runtime.
 */

/** Health state of a replica, as decided by the health scheduler's hysteresis. */
export type ReplicaHealth = "healthy" | "unhealthy" | "unknown";

/** Static identity of a replica — known at fleet startup, never changes. */
export interface Replica {
  /** Stable id, e.g. "replica-1". */
  id: string;
  /** Base URL, e.g. "http://127.0.0.1:8001". The adapter probes `${url}/health`. */
  url: string;
}

/**
 * Everything about a replica that changes over time. Owned by the registry,
 * written by the health scheduler on each poll.
 */
export interface ReplicaRuntime {
  health: ReplicaHealth;
  /** Replica's self-reported in-flight request count. 0 when the last probe failed. */
  inFlight: number;
  /**
   * Round-trip of the last *successful* health probe, in ms.
   * `null` when there is no valid measurement — never probed, or the last probe failed.
   */
  latencyMs: number | null;
  /** Consecutive failed probes. Resets to 0 on any success. */
  consecFailures: number;
  /** Consecutive successful probes. Resets to 0 on any failure. */
  consecSuccesses: number;
  /** ISO 8601 timestamp of the last probe attempt (success or failure); `null` before the first. */
  lastCheckedAt: string | null;
}

/** A replica plus its live runtime — the unit the registry stores and `/status` returns. */
export interface ReplicaState extends Replica {
  runtime: ReplicaRuntime;
}

/** Full point-in-time view of the fleet. This IS the `GET /status` response body. */
export interface RegistrySnapshot {
  /** ISO 8601 timestamp of when the snapshot was taken. */
  generatedAt: string;
  replicas: ReplicaState[];
}

/** Runtime for a freshly registered replica, before any health probe has run. */
export function initialRuntime(): ReplicaRuntime {
  return {
    health: "unknown",
    inFlight: 0,
    latencyMs: null,
    consecFailures: 0,
    consecSuccesses: 0,
    lastCheckedAt: null,
  };
}
