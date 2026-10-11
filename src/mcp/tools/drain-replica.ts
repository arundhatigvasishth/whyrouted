/**
 * `drain_replica` (M5b).
 *
 * Takes a replica out of rotation: the engine routes no new traffic to it.
 * Requests already in flight finish normally, because the engine only decides
 * at pick time. Operator intent, held beside health, so a health probe cannot
 * undo it (docs/milestones/m5b/shared-contract.md, P1). Draining a drained
 * replica is a successful no-op, and draining the last routable replica is
 * allowed and reported rather than refused.
 */

import { z } from "zod";
import { defineActionTool, type ActionToolDefinition } from "../server.js";
import { setReplicaAdmin, type ReplicaAdminStore } from "./replica-admin.js";

export function createDrainReplicaTool(store: ReplicaAdminStore): ActionToolDefinition {
  return defineActionTool({
    name: "drain_replica",
    description:
      "Stop routing new traffic to a replica. Requests already in flight finish. Stays drained until restore_replica, regardless of health. Draining an already drained replica changes nothing.",
    inputSchema: { replica_id: z.string().describe("The replica to drain, e.g. replica-2") },
    handler: ({ replica_id }) => setReplicaAdmin(store, replica_id, "drained"),
  });
}
