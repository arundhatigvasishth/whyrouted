/**
 * Storage contract for the fleet's live state (B3).
 *
 * This is what the health scheduler writes to and what `GET /status` reads from.
 * They depend on `RegistryStore`, not on a concrete class, so the backing store
 * can change without touching them.
 *
 * M1 ships the in-memory `Registry`. Having the interface now proves the seam:
 * a Redis-backed store (for multi-instance deploys, PRD §5.1) drops in behind it
 * — see `redis.ts` for the placeholder.
 *
 * Note: these signatures are synchronous because the in-memory store is. A real
 * Redis implementation would widen them to return Promises; that change is
 * deferred until Redis is actually on the table (out of M1 scope).
 */

import type { Replica, ReplicaHealth, ReplicaRuntime, RegistrySnapshot } from "../types.js";

export interface RegistryStore {
  /** Add a replica with a fresh runtime. Throws if the id is already registered. */
  register(replica: Replica): void;
  /** Merge a partial runtime patch into a replica's runtime. Throws on an unknown id. */
  updateRuntime(id: string, patch: Partial<ReplicaRuntime>): void;
  /** Set just the health state. Throws on an unknown id. */
  setHealth(id: string, health: ReplicaHealth): void;
  /** Point-in-time copy of the whole fleet, in registration order. */
  getSnapshot(): RegistrySnapshot;
}
