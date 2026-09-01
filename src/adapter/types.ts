/**
 * Replica adapter interface (J1).
 *
 * The routing engine and the health scheduler talk to replicas through exactly
 * these two methods (PRD §6). M1 ships the HTTP implementation against simulated
 * replicas (A6, `src/adapter/http.ts`); Phase 2 swaps in a real one (Ollama /
 * vLLM) behind the same interface, with no changes above this boundary.
 *
 * Signed off jointly in docs/m1/m1-shared-contract.md before either track
 * started. No behaviour here — the shape only.
 */

/** Result of probing one replica's health endpoint. */
export interface HealthResult {
  /** Did the replica answer a health probe successfully (2xx within the timeout)? */
  alive: boolean;
  /**
   * Measured round-trip of the probe, in ms. On failure this is the timeout
   * value the adapter waited — the scheduler does NOT persist it (it writes
   * `latencyMs: null` into the runtime for a failed probe).
   */
  latencyMs: number;
  /** Replica's self-reported in-flight request count. 0 when the probe failed. */
  inFlight: number;
}

/** Result of sending one inference request to a replica. */
export interface SendResult {
  /** Opaque passthrough of the replica's response body. Not typed in M1. */
  response: unknown;
  /** Measured round-trip of the request, in ms. */
  latencyMs: number;
}

/**
 * The only surface the rest of whyrouted uses to reach replicas.
 *
 * Implementations are constructed with the fleet's `Replica[]` (or an id→url
 * map); callers never see URLs, only ids.
 */
export interface ReplicaAdapter {
  /**
   * Probe one replica.
   *
   * NEVER rejects. A dead or unreachable replica resolves with
   * `{ alive: false, latencyMs: <timeout>, inFlight: 0 }` so the scheduler's
   * hysteresis loop stays branch-free.
   */
  checkHealth(replicaId: string): Promise<HealthResult>;

  /**
   * Send an inference request to one replica.
   *
   * REJECTS on transport failure, timeout, or a non-2xx response, so the
   * router (M2) can catch and retry against the next-best replica. No caller
   * uses this in M1.
   */
  sendRequest(replicaId: string, payload: unknown): Promise<SendResult>;
}
