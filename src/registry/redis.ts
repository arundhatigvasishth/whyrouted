/**
 * Redis-backed registry — STUB (B3).
 *
 * Not implemented. It exists only to prove `RegistryStore` is a real seam: a
 * second implementation that compiles against the same interface the scheduler
 * and the API depend on. Wiring actual Redis is out of M1 scope (PRD §5.1,
 * "Redis-backed for real multi-instance deployment").
 *
 * If you reached here at runtime, something constructed the wrong store — M1
 * uses the in-memory `Registry`.
 */

import type { Replica, ReplicaHealth, ReplicaRuntime, RegistrySnapshot } from "../types.js";
import type { RegistryStore } from "./types.js";

const NOT_IMPLEMENTED =
  "RedisRegistry is not implemented — M1 uses the in-memory Registry (see src/registry/registry.ts)";

export class RedisRegistry implements RegistryStore {
  register(_replica: Replica): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  updateRuntime(_id: string, _patch: Partial<ReplicaRuntime>): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  setHealth(_id: string, _health: ReplicaHealth): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  getSnapshot(): RegistrySnapshot {
    throw new Error(NOT_IMPLEMENTED);
  }
}
