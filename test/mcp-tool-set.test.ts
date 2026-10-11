import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/registry.js";
import { createRoutingConfig } from "../src/routing/config.js";
import { DEFAULT_SCORING_WEIGHTS } from "../src/routing/types.js";
import { createDecisionLog } from "../src/decisions/decision-log.js";
import { createFailoverLog } from "../src/events/failover-log.js";
import { createActionTools, createMcpTools, createReadTools } from "../src/mcp/tools/index.js";

const READ = [
  "explain_routing_decision",
  "get_failover_history",
  "get_fleet_status",
  "query_decisions",
];
const ACTION = [
  "drain_replica",
  "restore_replica",
  "set_routing_strategy",
  "set_scoring_weights",
  "simulate_failure",
];

function deps(host: string, token?: string) {
  const registry = new Registry();
  return {
    registry,
    failoverLog: createFailoverLog({ unhealthyThreshold: 3, healthyThreshold: 2 }),
    decisionLog: createDecisionLog(),
    routingConfig: createRoutingConfig({
      strategy: "least-loaded",
      weights: DEFAULT_SCORING_WEIGHTS,
    }),
    host,
    token,
  };
}

const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

describe("the registered tool set", () => {
  it("has exactly four read tools and exactly five action tools", () => {
    const d = deps("127.0.0.1");
    expect(names(createReadTools(d))).toEqual(READ);
    expect(names(createActionTools(d))).toEqual(ACTION);
    expect(createReadTools(d).every((t) => t.kind === "read")).toBe(true);
    expect(createActionTools(d).every((t) => t.kind === "action")).toBe(true);
  });

  it("registers all nine on a loopback bind with no token", () => {
    const { tools, notices } = createMcpTools(deps("127.0.0.1"));
    expect(names(tools)).toEqual([...ACTION, ...READ].sort());
    expect(notices).toEqual(["auth: none (loopback only)"]);
  });

  it("registers all nine with a token, on loopback or not", () => {
    const token = "a-long-enough-token";
    expect(names(createMcpTools(deps("127.0.0.1", token)).tools)).toHaveLength(9);

    const open = createMcpTools(deps("0.0.0.0", token));
    expect(names(open.tools)).toHaveLength(9);
    expect(open.notices).toContain("plain http: token is readable on the network");
  });

  it("leaves the five action tools out entirely on a non-loopback bind with no token", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "example.internal"]) {
      const { tools, notices } = createMcpTools(deps(host));
      expect(names(tools)).toEqual(READ);
      expect(notices.join(" ")).toContain("WR_MCP_TOKEN");
    }
  });

  it("never logs the token", () => {
    const token = "a-long-enough-token";
    const { notices } = createMcpTools(deps("0.0.0.0", token));
    expect(notices.join(" ")).not.toContain(token);
  });
});
