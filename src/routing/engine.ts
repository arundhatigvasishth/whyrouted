/**
 * Routing engine contract (K2, M2).
 *
 * Signature only, drafted solo alongside K1 for Arundhati to review and then
 * implement (K9). The engine is the one piece that touches both tracks: it
 * reads the registry, filters to healthy replicas, and delegates the actual
 * pick to whichever `RoutingStrategy` is currently active.
 */

export type RouteResult = { replicaId: string } | { error: "no_healthy_replicas" };

export interface RoutingEngine {
  /**
   * Pick a replica for the next request. Reads a fresh registry snapshot on
   * every call, so it always reflects the latest health state, no caching.
   */
  route(): RouteResult;
}
