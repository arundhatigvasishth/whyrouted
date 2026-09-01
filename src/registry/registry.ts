/**
 * Service registry (B2).
 *
 * The in-memory record of every replica in the fleet and its current state.
 * Pure state: it stores what it is told and hands back snapshots. It emits no
 * events and calls nothing — the health scheduler writes into it each poll, the
 * `GET /status` endpoint reads a snapshot out of it, and that is the whole
 * contract.
 *
 * Keyed by `replica.id`. Iteration and snapshot order is registration order.
 */

import type {
  Replica,
  ReplicaHealth,
  ReplicaRuntime,
  ReplicaState,
  RegistrySnapshot,
} from "../types.js";
import { initialRuntime } from "../types.js";
import type { RegistryStore } from "./types.js";

export class Registry implements RegistryStore {
  private readonly replicas = new Map<string, ReplicaState>();

  /**
   * Add a replica with a fresh runtime (`unknown` health, zeros, nulls).
   * Throws if a replica with the same id is already registered — re-registering
   * would silently wipe live runtime, which is always a fleet-setup bug.
   */
  register(replica: Replica): void {
    if (this.replicas.has(replica.id)) {
      throw new Error(`replica "${replica.id}" is already registered`);
    }
    this.replicas.set(replica.id, {
      id: replica.id,
      url: replica.url,
      runtime: initialRuntime(),
    });
  }

  /**
   * Merge a partial runtime update into a replica's runtime. Used by the health
   * scheduler on every poll to write latency, in-flight, and the consecutive
   * counters. Throws on an unknown id.
   */
  updateRuntime(id: string, patch: Partial<ReplicaRuntime>): void {
    const state = this.require(id);
    state.runtime = { ...state.runtime, ...patch };
  }

  /**
   * Set just the health state — the scheduler calls this on a hysteresis
   * transition. Throws on an unknown id.
   */
  setHealth(id: string, health: ReplicaHealth): void {
    this.require(id).runtime.health = health;
  }

  /**
   * Point-in-time view of the whole fleet, in registration order. Every object
   * is a fresh copy, so callers cannot mutate registry state by holding the
   * result. This IS the `GET /status` response body.
   */
  getSnapshot(): RegistrySnapshot {
    return {
      generatedAt: new Date().toISOString(),
      replicas: [...this.replicas.values()].map((state) => ({
        id: state.id,
        url: state.url,
        runtime: { ...state.runtime },
      })),
    };
  }

  /** Whether a replica id is registered. */
  has(id: string): boolean {
    return this.replicas.has(id);
  }

  private require(id: string): ReplicaState {
    const state = this.replicas.get(id);
    if (state === undefined) {
      throw new Error(`replica "${id}" is not registered`);
    }
    return state;
  }
}
