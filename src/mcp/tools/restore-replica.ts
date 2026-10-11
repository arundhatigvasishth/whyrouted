/**
 * `restore_replica` (M5b).
 *
 * The inverse of `drain_replica`: clears the drain and nothing else. A replica
 * that is also unhealthy stays out of rotation, and the result says so instead
 * of implying it is back. It does not clear a simulated fault; that is
 * `simulate_failure` with mode `revive` (docs/milestones/m5b/shared-contract.md,
 * P1 and P4).
 */

import { z } from "zod";
import { defineActionTool, type ActionToolDefinition } from "../server.js";
import { setReplicaAdmin, type ReplicaAdminStore } from "./replica-admin.js";

export function createRestoreReplicaTool(store: ReplicaAdminStore): ActionToolDefinition {
  return defineActionTool({
    name: "restore_replica",
    description:
      "Return a drained replica to the candidate pool. Clears only the drain: a replica that is also unhealthy stays out of rotation until it recovers. Restoring an active replica changes nothing.",
    inputSchema: { replica_id: z.string().describe("The replica to restore, e.g. replica-2") },
    handler: ({ replica_id }) => setReplicaAdmin(store, replica_id, "active"),
  });
}
