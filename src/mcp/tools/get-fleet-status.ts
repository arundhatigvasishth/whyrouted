/**
 * `get_fleet_status` (O7, M5a).
 *
 * A live snapshot of every replica's health, load, and latency. Returns the
 * registry's `RegistrySnapshot` verbatim, the same body `GET /status` serves,
 * so the two can never disagree (docs/milestones/m5a/shared-contract.md,
 * "Also agreed"). Takes no arguments.
 */

import type { RegistryStore } from "../../registry/types.js";
import type { RegistrySnapshot } from "../../types.js";
import { defineTool, type ToolDefinition } from "../server.js";

export function createGetFleetStatusTool(store: RegistryStore): ToolDefinition {
  return defineTool({
    name: "get_fleet_status",
    description:
      "Live snapshot of every replica's health, in-flight load, and latency, read from the registry at call time.",
    inputSchema: {},
    handler: () => snapshotOutput(store.getSnapshot()),
  });
}

function snapshotOutput(snapshot: RegistrySnapshot) {
  if (snapshot.replicas.length === 0) {
    return { kind: "no_data" as const, reason: "the registry has no replicas registered" };
  }
  return {
    kind: "data" as const,
    data: snapshot,
    source: "registry" as const,
    recordIds: snapshot.replicas.map((r) => r.id),
  };
}
