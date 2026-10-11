/**
 * M5a integration test (joint task).
 *
 * Builds the system the way `main.ts` wires it, in-process (same reasoning as
 * the M3 and M4 tests: it needs live references to the stores to assert
 * against), then drives real `POST /route` traffic, kills a replica so one
 * request takes a retry round, and asks all four read tools about what
 * happened through a real MCP client over HTTP, not by calling tool
 * functions directly.
 *
 * What it checks is the milestone's definition of done, end to end:
 *   - exactly the four read tools are registered, no M5b action tool;
 *   - each answer matches the underlying store, and every id in `recordIds`
 *     exists in that store (the grounding constraint, PRD section 8);
 *   - a question the data cannot answer says so instead of guessing.
 *
 * Round-robin keeps the pick order deterministic, as in the M4 test, so the
 * retried request is the one that first hits the killed replica.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, fleetReplicas } from "../../src/config.js";
import { launchFleet, type RunningFleet } from "../../src/replica/launch.js";
import { Registry } from "../../src/registry/registry.js";
import { HttpReplicaAdapter } from "../../src/adapter/http.js";
import { HealthScheduler } from "../../src/health/scheduler.js";
import { createRoutingConfig } from "../../src/routing/config.js";
import { createRoutingEngine } from "../../src/routing/engine.js";
import { startStatusServer, type RunningStatusServer } from "../../src/api/server.js";
import { createFailoverLog } from "../../src/events/failover-log.js";
import { createDecisionLog } from "../../src/decisions/decision-log.js";
import { startMcpServer, type RunningMcpServer } from "../../src/mcp/server.js";
import { createReadTools } from "../../src/mcp/tools/index.js";
import {
  resolveCite,
  type ExplainRoutingDecisionData,
} from "../../src/mcp/tools/explain-routing-decision.js";
import type { AggregateData } from "../../src/mcp/tools/query-decisions.js";
import type { FailoverHistoryData } from "../../src/mcp/tools/get-failover-history.js";
import type { ToolResult } from "../../src/mcp/types.js";
import type { RegistrySnapshot } from "../../src/types.js";

const HOST = "127.0.0.1";
const BASE_PORT = 8501;
const STATUS_PORT = 8510;
const FLEET_SIZE = 3;
const TARGET = "replica-3";

const ACTION_TOOLS = [
  "drain_replica",
  "restore_replica",
  "simulate_failure",
  "set_routing_strategy",
  "set_scoring_weights",
];

let fleet: RunningFleet | undefined;
let status: RunningStatusServer | undefined;
let mcp: RunningMcpServer | undefined;
let client: Client | undefined;
let scheduler: HealthScheduler | undefined;

afterEach(async () => {
  await client?.close();
  scheduler?.stop();
  await mcp?.close();
  await status?.close();
  await fleet?.stop();
  client = undefined;
  mcp = undefined;
  status = undefined;
  fleet = undefined;
  scheduler = undefined;
});

describe("M5a end to end", () => {
  it("answers all four read tools from live state, grounded in what was recorded", async () => {
    const config = loadConfig({
      WR_HOST: HOST,
      WR_FLEET_SIZE: String(FLEET_SIZE),
      WR_BASE_PORT: String(BASE_PORT),
      WR_STATUS_PORT: String(STATUS_PORT),
      WR_MCP_PORT: String(STATUS_PORT + 1),
      WR_HEALTH_INTERVAL_MS: "200",
      WR_HEALTH_TIMEOUT_MS: "150",
      WR_UNHEALTHY_THRESHOLD: "3",
      WR_HEALTHY_THRESHOLD: "2",
      WR_MAX_RETRIES: "2",
      WR_ROUTING_STRATEGY: "round-robin",
    });
    const replicas = fleetReplicas(config);

    fleet = launchFleet(config);
    await Promise.all(replicas.map((r) => waitUntilReachable(r.url, 10_000)));

    const registry = new Registry();
    for (const r of replicas) registry.register(r);

    const adapter = new HttpReplicaAdapter({ replicas, healthTimeoutMs: config.healthTimeoutMs });
    const failoverLog = createFailoverLog({
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
    });
    const decisionLog = createDecisionLog();

    scheduler = new HealthScheduler({
      adapter,
      sink: registry,
      replicaIds: replicas.map((r) => r.id),
      intervalMs: config.healthIntervalMs,
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
      onTransition: (t) => failoverLog.handleTransition(t),
    });
    scheduler.start();

    const engine = createRoutingEngine({
      registry,
      config: createRoutingConfig({
        strategy: config.routingStrategy,
        weights: config.scoringWeights,
      }),
    });
    status = await startStatusServer({
      store: registry,
      engine,
      adapter,
      scheduler,
      failoverLog,
      decisionLog,
      maxRetries: config.maxRetries,
      port: config.statusPort,
      host: config.host,
    });
    mcp = await startMcpServer({
      tools: createReadTools({ registry, failoverLog, decisionLog }),
      port: config.mcpPort,
      host: config.host,
    });
    client = new Client({ name: "m5a-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));

    await waitForAllHealthy(status.url, FLEET_SIZE);

    const route = async () => {
      const res = await fetch(`${status!.url}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { prompt: "ping" } }),
      });
      return (await res.json()) as { replicaId: string; latencyMs: number; requestId: string };
    };

    // Round-robin: replica-1, replica-2, then the cursor sits on replica-3.
    const responses = [await route(), await route()];
    const targetUrl = replicas.find((r) => r.id === TARGET)!.url;
    expect((await fetch(`${targetUrl}/admin/kill`, { method: "POST" })).ok).toBe(true);
    // This one first picks the killed replica, fails, and retries on a survivor.
    responses.push(await route(), await route(), await route());

    const call = async <T>(name: string, args: Record<string, unknown>) => {
      const raw = await client!.callTool({ name, arguments: args });
      const content = raw.content as Array<{ text: string }>;
      return { isError: raw.isError, result: JSON.parse(content[0]!.text) as ToolResult<T> };
    };

    // Exactly the four read tools, no action tool.
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "explain_routing_decision",
      "get_failover_history",
      "get_fleet_status",
      "query_decisions",
    ]);
    for (const action of ACTION_TOOLS) expect(names).not.toContain(action);

    // get_fleet_status matches GET /status, and shows the dead replica unhealthy.
    const fleetRes = await call<RegistrySnapshot>("get_fleet_status", {});
    expect(fleetRes.result.ok).toBe(true);
    if (!fleetRes.result.ok) return;
    const http = (await (await fetch(`${status.url}/status`)).json()) as RegistrySnapshot;
    expect(fleetRes.result.data.replicas.map((r) => [r.id, r.runtime.health])).toEqual(
      http.replicas.map((r) => [r.id, r.runtime.health]),
    );
    expect(fleetRes.result.data.replicas.find((r) => r.id === TARGET)?.runtime.health).toBe(
      "unhealthy",
    );
    expect(fleetRes.result.groundedIn.recordIds).toEqual(replicas.map((r) => r.id));

    // get_failover_history returns the ejection, with ids that exist in the log.
    const history = await call<FailoverHistoryData>("get_failover_history", { last: "10 minutes" });
    expect(history.result.ok).toBe(true);
    if (!history.result.ok) return;
    const logged = failoverLog.query({});
    expect(history.result.data.events).toEqual(logged);
    expect(
      history.result.data.events.some((e) => e.replicaId === TARGET && e.kind === "ejected"),
    ).toBe(true);
    expect(history.result.groundedIn.recordIds).toEqual(logged.map((e) => e.id));

    // A window before anything happened says so, it does not return an empty answer.
    const early = await call("get_failover_history", { to: "2000-01-01T00:00:00Z" });
    expect(early.isError).toBe(false);
    expect(early.result).toMatchObject({ ok: false, code: "no_data" });

    // explain_routing_decision tells the whole retry story for the retried request.
    const decisions = decisionLog.query({});
    expect(decisions).toHaveLength(5);
    // The id a client gets back from POST /route is the one the decision is recorded under.
    expect(decisions.map((d) => d.requestId)).toEqual(responses.map((r) => r.requestId));
    const retried = decisions.find((d) => d.rounds.length === 2)!;
    expect(retried).toBeDefined();
    const explained = await call<ExplainRoutingDecisionData>("explain_routing_decision", {
      request_id: retried.requestId,
    });
    expect(explained.result.ok).toBe(true);
    if (!explained.result.ok) return;
    expect(explained.result.data.decision).toEqual(retried);
    expect(explained.result.data.lines).toHaveLength(1 + retried.rounds.length);
    expect(explained.result.groundedIn).toMatchObject({
      source: "decision_log",
      recordIds: [retried.id],
    });
    for (const line of explained.result.data.lines) {
      expect(line.cites.length).toBeGreaterThan(0);
      for (const cite of line.cites) {
        expect(resolveCite(explained.result.data.decision, cite)).not.toBeUndefined();
      }
    }

    // An unknown request id is no_data, not a guess.
    const unknown = await call("explain_routing_decision", { request_id: "not-a-real-request" });
    expect(unknown.isError).toBe(false);
    expect(unknown.result).toMatchObject({ ok: false, code: "no_data" });

    // query_decisions, point lookup: same explanation as explain_routing_decision.
    const point = await call<ExplainRoutingDecisionData>("query_decisions", {
      natural_language_query: `why did request ${retried.requestId} go where it did?`,
    });
    expect(point.result).toMatchObject({ ok: true, data: explained.result.data });

    // query_decisions, aggregate: counts and latency come only from recorded decisions.
    const agg = await call<AggregateData>("query_decisions", {
      natural_language_query: "how many requests failed in the last 10 minutes and what was p99?",
    });
    expect(agg.result.ok).toBe(true);
    if (!agg.result.ok) return;
    expect(agg.result.data).toMatchObject({ total: 5, served: 5, failed: 0 });
    const observed = responses.map((r) => r.latencyMs).sort((a, b) => a - b);
    expect(agg.result.data.latency).toMatchObject({
      sampleSize: 5,
      p99Ms: observed[observed.length - 1],
    });
    expect(agg.result.groundedIn.recordIds).toEqual(decisions.map((d) => d.id));

    // A window with no decisions is no_data, never zeros; an unsupported question is rejected.
    const empty = await call("query_decisions", {
      natural_language_query: "what was p99 between 2000-01-01T00:00:00Z and 2000-01-01T00:10:00Z",
    });
    expect(empty.result).toMatchObject({ ok: false, code: "no_data" });
    const unsupported = await call("query_decisions", {
      natural_language_query: "is the fleet happy?",
    });
    expect(unsupported.isError).toBe(true);
    expect(unsupported.result).toMatchObject({ ok: false, code: "invalid_input" });
  }, 40_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReachable(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`${url}/health`);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`replica at ${url} did not become reachable within ${timeoutMs}ms`);
      }
      await sleep(50);
    }
  }
}

async function waitForAllHealthy(statusUrl: string, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await fetch(`${statusUrl}/status`);
    if (res.ok) {
      const snap = (await res.json()) as RegistrySnapshot;
      if (
        snap.replicas.length === count &&
        snap.replicas.every((r) => r.runtime.health === "healthy")
      ) {
        return;
      }
    }
    if (Date.now() > deadline)
      throw new Error("timed out waiting for all replicas to reach healthy");
    await sleep(25);
  }
}
