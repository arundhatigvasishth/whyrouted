/**
 * The read tools M5a exposes, assembled in one place so `main.ts` and the
 * tests build the same set. Each factory takes the store it reads as a plain
 * argument (docs/milestones/m5a/shared-contract.md, O1), so nothing here
 * knows about a server or a process.
 *
 * M5a ships exactly the read tools. Action tools (drain, restore, simulate
 * failure, strategy and weight tuning) are M5b and do not belong in this list.
 */

import { z } from "zod";
import type { DecisionLog } from "../../decisions/types.js";
import type { FailoverLog } from "../../events/types.js";
import type { RegistryStore } from "../../registry/types.js";
import { defineTool, type ToolDefinition } from "../server.js";
import { createExplainRoutingDecision } from "./explain-routing-decision.js";
import { createGetFailoverHistoryTool } from "./get-failover-history.js";
import { createGetFleetStatusTool } from "./get-fleet-status.js";

export interface ReadToolDeps {
  registry: RegistryStore;
  failoverLog: Pick<FailoverLog, "query">;
  decisionLog: Pick<DecisionLog, "get">;
}

export function createReadTools(deps: ReadToolDeps): ToolDefinition[] {
  return [
    createGetFleetStatusTool(deps.registry),
    createGetFailoverHistoryTool(deps.failoverLog),
    defineTool({
      name: "explain_routing_decision",
      description:
        "Explain why one request was routed where it was, from its recorded decision: every round, every candidate's score, and every exclusion. Each line cites the decision fields it came from.",
      inputSchema: { request_id: z.string().describe("The request id to explain") },
      handler: createExplainRoutingDecision({ decisionLog: deps.decisionLog }),
    }),
  ];
}
