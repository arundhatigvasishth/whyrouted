/**
 * The read tools M5a exposes, assembled in one place so `main.ts` and the
 * tests build the same set. Each factory takes the store it reads as a plain
 * argument (docs/milestones/m5a/shared-contract.md, O1), so nothing here
 * knows about a server or a process.
 *
 * M5a ships exactly the read tools. Action tools (drain, restore, simulate
 * failure, strategy and weight tuning) are M5b and do not belong in this list.
 */

import type { FailoverLog } from "../../events/types.js";
import type { RegistryStore } from "../../registry/types.js";
import type { ToolDefinition } from "../server.js";
import { createGetFailoverHistoryTool } from "./get-failover-history.js";
import { createGetFleetStatusTool } from "./get-fleet-status.js";

export interface ReadToolDeps {
  registry: RegistryStore;
  failoverLog: Pick<FailoverLog, "query">;
}

export function createReadTools(deps: ReadToolDeps): ToolDefinition[] {
  return [createGetFleetStatusTool(deps.registry), createGetFailoverHistoryTool(deps.failoverLog)];
}
