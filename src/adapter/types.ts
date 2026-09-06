/**
 * Replica adapter interface (J1; error taxonomy added M3, L1).
 *
 * The routing engine and the health scheduler talk to replicas through exactly
 * these two methods (PRD §6). M1 ships the HTTP implementation against simulated
 * replicas (A6, `src/adapter/http.ts`); Phase 2 swaps in a real one (Ollama /
 * vLLM) behind the same interface, with no changes above this boundary.
 *
 * Signed off jointly in docs/milestones/m1/shared-contract.md before either
 * track started. M3's error taxonomy (L1) is drafted solo, pending
 * Arundhati's review, same as M2's K1/K2 — see
 * docs/milestones/m3/shared-contract.md once it exists.
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
   * REJECTS on transport failure, timeout, or a non-2xx response, always with
   * a {@link ReplicaRequestError} (L1, M3), so the router (M3's retry loop,
   * L11) can tell a retryable failure from one it should surface to the
   * client immediately.
   */
  sendRequest(replicaId: string, payload: unknown): Promise<SendResult>;
}

/** Why a `sendRequest` call failed, for the retry loop to act on (L1, M3). */
export type ReplicaErrorKind = "timeout" | "connection" | "http_status";

/**
 * Typed rejection from `sendRequest`. Extends `Error` so existing "catches a
 * generic Error" code keeps working unchanged; new code narrows on `kind` /
 * `retryable`.
 *
 * Retryability, fixed by this contract:
 * - `timeout` — always retryable (the replica may just be slow or dead).
 * - `connection` — always retryable (refused / unreachable; may be transient).
 * - `http_status` — retryable only for a 5xx `status` (server-side failure).
 *   A 4xx is the client's fault (bad payload) and retrying against a
 *   different replica would not help, so it is NOT retryable.
 */
export class ReplicaRequestError extends Error {
  readonly kind: ReplicaErrorKind;
  readonly retryable: boolean;
  /** HTTP status code, present only when `kind === "http_status"`. */
  readonly status?: number;

  constructor(kind: ReplicaErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ReplicaRequestError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind !== "http_status" || (status !== undefined && status >= 500);
  }
}
