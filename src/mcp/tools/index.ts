/**
 * The read tools M5a exposes, assembled in one place so `main.ts` and the
 * tests build the same set. Each factory takes the store it reads as a plain
 * argument (docs/milestones/m5a/shared-contract.md, O1), so nothing here
 * knows about a server or a process.
 *
 * M5a shipped exactly the read tools. M5b's action tools (drain, restore,
 * simulate failure, strategy and weight tuning) are assembled separately by
 * `createActionTools`, so the read set stays exactly four and `main.ts` can
 * decide whether to register the action set at all (docs/milestones/m5b/
 * shared-contract.md, P2).
 */

import { z } from "zod";
import type { DecisionLog } from "../../decisions/types.js";
import type { FailoverLog } from "../../events/types.js";
import type { RegistryStore } from "../../registry/types.js";
import type { RoutingConfig } from "../../routing/types.js";
import { defineTool, type ActionToolDefinition, type ReadToolDefinition } from "../server.js";
import { createExplainRoutingDecision } from "./explain-routing-decision.js";
import { createGetFailoverHistoryTool } from "./get-failover-history.js";
import { createGetFleetStatusTool } from "./get-fleet-status.js";
import { createQueryDecisions } from "./query-decisions.js";
import { createSetRoutingStrategyTool } from "./set-routing-strategy.js";
import { createSetScoringWeightsTool } from "./set-scoring-weights.js";

export interface ReadToolDeps {
  registry: RegistryStore;
  failoverLog: Pick<FailoverLog, "query">;
  decisionLog: Pick<DecisionLog, "get" | "query">;
}

export function createReadTools(deps: ReadToolDeps): ReadToolDefinition[] {
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
    defineTool({
      name: "query_decisions",
      description:
        'Answer a question from the recorded routing decisions. Supports a point lookup by request id ("why did request <uuid> go where it did") and an aggregate over a time range with p50, p95, p99, latency, count, how many, failed, failures or per replica ("what was p99 between 15:00 and 15:10", "how many requests failed in the last 10 minutes"). Answers only from recorded data and says so when there is none.',
      inputSchema: {
        natural_language_query: z.string().describe("The question, in one of the supported shapes"),
      },
      handler: createQueryDecisions({ decisionLog: deps.decisionLog }),
    }),
  ];
}

export interface ActionToolDeps {
  routingConfig: RoutingConfig;
}

/**
 * The action tools built so far. Each one closes over the live store it
 * changes, the same instance the router reads, so a change applies to the next
 * request. The set grows to exactly five as the M5b tools land.
 */
export function createActionTools(deps: ActionToolDeps): ActionToolDefinition[] {
  return [
    createSetRoutingStrategyTool(deps.routingConfig),
    createSetScoringWeightsTool(deps.routingConfig),
  ];
}
