/**
 * Shared core of `drain_replica` and `restore_replica` (M5b).
 *
 * Both tools do the same thing in opposite directions: read the replica, flip
 * its `admin` state through the registry, read it back. They differ only in
 * the target state and the advisory notes, so the read-write-read lives here
 * once. The result's `after` is read back from the registry after the write,
 * never echoed from the arguments (docs/milestones/m5b/shared-contract.md,
 * P3), so it is what the engine will see on the next pick.
 */

import type { RegistryStore } from "../../registry/types.js";
import type { ReplicaAdmin, ReplicaHealth, ReplicaState } from "../../types.js";
import type { ActionOutput } from "../action.js";

/** What `drain_replica` and `restore_replica` report before and after the write. */
export interface ReplicaAdminState {
  replicaId: string;
  admin: ReplicaAdmin;
  health: ReplicaHealth;
  /** `admin === "active" && health === "healthy"`: whether the engine can pick it. */
  routable: boolean;
  /** How many replicas are routable in the registry at this moment. */
  routableReplicas: number;
}

export type ReplicaAdminStore = Pick<RegistryStore, "getSnapshot" | "setAdmin">;

const isRoutable = (r: ReplicaState): boolean =>
  r.admin === "active" && r.runtime.health === "healthy";

function stateOf(store: ReplicaAdminStore, replicaId: string): ReplicaAdminState | undefined {
  const replicas = store.getSnapshot().replicas;
  const replica = replicas.find((r) => r.id === replicaId);
  if (replica === undefined) return undefined;
  return {
    replicaId,
    admin: replica.admin,
    health: replica.runtime.health,
    routable: isRoutable(replica),
    routableReplicas: replicas.filter(isRoutable).length,
  };
}

/**
 * Move one replica to `target` and report what changed. An unknown id is
 * decided before any write, so a failed call changes nothing.
 */
export function setReplicaAdmin(
  store: ReplicaAdminStore,
  replicaId: string,
  target: ReplicaAdmin,
): ActionOutput<ReplicaAdminState> {
  const before = stateOf(store, replicaId);
  if (before === undefined) {
    return { kind: "unknown_replica", reason: `no replica with id "${replicaId}" is registered` };
  }

  store.setAdmin(replicaId, target);

  const after = stateOf(store, replicaId);
  if (after === undefined) {
    throw new Error(`replica "${replicaId}" vanished from the registry during the update`);
  }

  const notes: string[] = [];
  if (target === "drained" && after.routableReplicas === 0) {
    notes.push("no replica is routable now: requests will fail until one is restored");
  }
  if (target === "active" && after.health !== "healthy") {
    notes.push(
      `still not routable: the replica is ${after.health}, and restoring clears only the drain`,
    );
  }
  return { kind: "applied", before, after, ...(notes.length > 0 && { notes }) };
}
