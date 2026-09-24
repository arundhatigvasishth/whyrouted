/**
 * Decision record (N2, M4).
 *
 * The structured record every `POST /route` request writes: request id,
 * timestamp, every round it went through, and which replica (if any) it
 * ultimately came back from. This is **not** the M3 failover log (that is
 * the ejection/recovery timeline); it is the substrate M5a's
 * `explain_routing_decision(request_id)` and `query_decisions(...)` will
 * read. Shape fixed by docs/milestones/m4/shared-contract.md, N2 and N4.
 */

import type { ReplicaErrorKind } from "../adapter/types.js";
import type { CandidateScore, ExcludedCandidate } from "../routing/types.js";

export interface DecisionRound {
  /** Every candidate the strategy actually scored this round. Empty if none
   *  survived filtering. May also be missing a candidate the strategy itself
   *  declined to score (latency-weighted's null-latency case, N1); that gap
   *  is documented strategy behaviour, not an engine bug. */
  candidates: CandidateScore[];
  /** Every replica the engine filtered out before scoring, with why. */
  excluded: ExcludedCandidate[];
  strategy: string;
  /**
   * "picked": the engine returned a replica id this round (whether or not the
   *   request to it then succeeded, see `failureReason`).
   * "no_routable_replica": candidates existed (possibly zero after
   *   exclusion) but the engine could not return a pick.
   * "no_healthy_replicas": the registry had no healthy replica at all.
   */
  outcome: "picked" | "no_routable_replica" | "no_healthy_replicas";
  /** Present only when outcome === "picked". */
  pickedReplicaId?: string;
  /**
   * Why this round's pick didn't resolve the request, if it didn't. Absent
   * on the round that actually returned 200. Mirrors the HTTP response's
   * `RouteAttempt` minus `replicaId` (redundant here with `pickedReplicaId`),
   * set by the API layer from the same `ReplicaRequestError` the retry loop
   * already handles, so a multi-round `Decision` keeps its failure detail
   * after the HTTP response carrying `attempts` is long gone.
   */
  failureReason?: { kind: ReplicaErrorKind; status?: number };
}

export interface Decision {
  /** Unique id, crypto.randomUUID(). Distinct from requestId: one Decision
   *  per request, but the id is its own so a future re-record (never
   *  planned, but not ruled out) wouldn't collide with the request id. */
  id: string;
  requestId: string;
  /** ISO 8601, stamped when the Decision is recorded (request resolution),
   *  not when the first round started. */
  at: string;
  /** In attempt order: index 0 is the first engine call this request made. */
  rounds: DecisionRound[];
  /** The replica the client's response actually came from, or null if the
   *  request ended in any kind of failure, including a non-retryable 502
   *  where a replica was picked but never returned a usable response. */
  chosenReplicaId: string | null;
}

export interface DecisionLog {
  record(decision: Decision): void;
  /** Decisions with from <= at <= to, both bounds optional and inclusive,
   *  ascending by `at`. */
  query(range: { from?: string; to?: string }): Decision[];
  /** Point lookup for M5a's explain_routing_decision. Undefined if no
   *  Decision was ever recorded for that requestId. */
  get(requestId: string): Decision | undefined;
}
