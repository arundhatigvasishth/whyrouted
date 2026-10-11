/**
 * `set_routing_strategy` (P13, M5b).
 *
 * Swaps the active routing strategy live. The engine reads `RoutingConfig` on
 * every `route()` call, so the change applies to the next request with no
 * restart. Result shape and rules fixed by
 * docs/milestones/m5b/shared-contract.md, P3.
 *
 * `before` and `after` are both read from the config, so the result reports
 * what the router will actually use, not what was asked for. An unknown name
 * is rejected before anything is written, with the valid names listed.
 */

import { z } from "zod";
import { STRATEGY_NAMES } from "../../routing/strategies/index.js";
import type { RoutingConfig, StrategyName } from "../../routing/types.js";
import { defineActionTool, type ActionToolDefinition } from "../server.js";

export interface StrategyState {
  strategy: StrategyName;
}

export function createSetRoutingStrategyTool(config: RoutingConfig): ActionToolDefinition {
  return defineActionTool({
    name: "set_routing_strategy",
    description: `Swap the live routing strategy. One of: ${STRATEGY_NAMES.join(", ")}. Takes effect on the next request. Returns the strategy before and after, read back from the router's config.`,
    inputSchema: {
      strategy: z.string().describe(`The strategy to use: ${STRATEGY_NAMES.join(", ")}`),
    },
    handler: ({ strategy }) => {
      if (!(STRATEGY_NAMES as string[]).includes(strategy)) {
        return {
          kind: "invalid_input" as const,
          reason: `unknown routing strategy ${JSON.stringify(strategy)}, expected one of ${STRATEGY_NAMES.join(", ")}`,
        };
      }
      const before: StrategyState = { strategy: config.getStrategyName() };
      config.setStrategyName(strategy as StrategyName);
      const after: StrategyState = { strategy: config.getStrategyName() };
      return { kind: "applied" as const, before, after };
    },
  });
}
