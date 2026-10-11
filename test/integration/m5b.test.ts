/**
 * M5b integration test (joint task).
 *
 * Builds the system the way `main.ts` wires it, in-process (same reasoning as
 * the M3 to M5a tests: it needs live references to the stores to assert
 * against), then drives the five action tools through a real MCP client over
 * HTTP, with the bearer token on, and checks each effect where it actually
 * lands: in `get_fleet_status`, in `POST /route`, and in the decision log.
 *
 * This is the measured form of PRD section 8's action-reliability metric:
 * every drain, restore, and strategy change is reflected in live fleet state
 * within 1s, asserted here against a clock and not just against the tool's own
 * answer. It also checks the cross-track cases the unit tests cannot: a
 * routing decision made after a drain is explained as an operator action, and
 * a simulated failure fails over with no failed request.
 *
 * Round-robin keeps the pick order deterministic, as in the M4 and M5a tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, fleetReplicas } from "../../src/config.js";
import { launchFleet, type RunningFleet } from "../../src/replica/launch.js";
import { createHttpFaultInjector } from "../../src/replica/fault-injector.js";
import { Registry } from "../../src/registry/registry.js";
import { HttpReplicaAdapter } from "../../src/adapter/http.js";
import { HealthScheduler } from "../../src/health/scheduler.js";
import { createRoutingConfig } from "../../src/routing/config.js";
import { createRoutingEngine } from "../../src/routing/engine.js";
import { startStatusServer, type RunningStatusServer } from "../../src/api/server.js";
import { createFailoverLog } from "../../src/events/failover-log.js";
import { createDecisionLog } from "../../src/decisions/decision-log.js";
import type { DecisionLog } from "../../src/decisions/types.js";
import { startMcpServer, type RunningMcpServer } from "../../src/mcp/server.js";
import { createMcpTools } from "../../src/mcp/tools/index.js";
import type { ActionResult } from "../../src/mcp/action.js";
import type { ReplicaAdminState } from "../../src/mcp/tools/replica-admin.js";
import type { ExplainRoutingDecisionData } from "../../src/mcp/tools/explain-routing-decision.js";
import type { ToolResult } from "../../src/mcp/types.js";
import type { RoutingConfig, StrategyName } from "../../src/routing/types.js";
import type { RegistrySnapshot } from "../../src/types.js";

const HOST = "127.0.0.1";
const BASE_PORT = 8601;
const STATUS_PORT = 8610;
const FLEET_SIZE = 3;
const TOKEN = "m5b-integration-token-0123456789";
/** PRD section 8: an action is reflected in live fleet state within this long. */
const REFLECT_MS = 1000;

const ACTION_TOOLS = [
  "drain_replica",
  "restore_replica",
  "set_routing_strategy",
  "set_scoring_weights",
  "simulate_failure",
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

interface Booted {
  registry: Registry;
  decisionLog: DecisionLog;
  routingConfig: RoutingConfig;
  statusUrl: string;
  mcpUrl: string;
}

async function boot(strategy: StrategyName = "round-robin"): Promise<Booted> {
  const config = loadConfig({
    WR_HOST: HOST,
    WR_FLEET_SIZE: String(FLEET_SIZE),
    WR_BASE_PORT: String(BASE_PORT),
    WR_STATUS_PORT: String(STATUS_PORT),
    WR_MCP_PORT: String(STATUS_PORT + 1),
    WR_MCP_TOKEN: TOKEN,
    WR_HEALTH_INTERVAL_MS: "200",
    WR_HEALTH_TIMEOUT_MS: "150",
    WR_UNHEALTHY_THRESHOLD: "3",
    WR_HEALTHY_THRESHOLD: "2",
    WR_MAX_RETRIES: "2",
    WR_ROUTING_STRATEGY: strategy,
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

  const routingConfig = createRoutingConfig({
    strategy: config.routingStrategy,
    weights: config.scoringWeights,
  });
  const engine = createRoutingEngine({ registry, config: routingConfig });
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

  const { tools } = createMcpTools({
    registry,
    failoverLog,
    decisionLog,
    routingConfig,
    injector: createHttpFaultInjector({ replicas }),
    host: config.host,
    token: config.mcpToken,
  });
  mcp = await startMcpServer({
    tools,
    port: config.mcpPort,
    host: config.host,
    token: config.mcpToken,
  });
  client = new Client({ name: "m5b-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );

  await waitForAllHealthy(status.url, FLEET_SIZE);
  return { registry, decisionLog, routingConfig, statusUrl: status.url, mcpUrl: mcp.url };
}

async function call<T>(name: string, args: Record<string, unknown>) {
  const raw = await client!.callTool({ name, arguments: args });
  const content = raw.content as Array<{ text: string }>;
  return { isError: raw.isError, result: JSON.parse(content[0]!.text) as T };
}

interface RouteBody {
  replicaId: string;
  strategy: string;
  requestId: string;
}

async function route(statusUrl: string): Promise<RouteBody & { httpStatus: number }> {
  const res = await fetch(`${statusUrl}/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { prompt: "ping" } }),
  });
  return { ...((await res.json()) as RouteBody), httpStatus: res.status };
}

const routeMany = async (statusUrl: string, n: number) => {
  const out: Array<RouteBody & { httpStatus: number }> = [];
  for (let i = 0; i < n; i++) out.push(await route(statusUrl));
  return out;
};

const fleetStatus = async (statusUrl: string) =>
  (await (await fetch(`${statusUrl}/status`)).json()) as RegistrySnapshot;

describe("M5b end to end", () => {
  it("registers all nine tools behind the token, and rejects a call without it", async () => {
    const { mcpUrl } = await boot();

    const names = (await client!.listTools()).tools.map((t) => t.name);
    for (const action of ACTION_TOOLS) expect(names).toContain(action);
    expect(names).toHaveLength(9);

    // The same endpoint with no token, and with a wrong one, is refused before MCP parsing.
    for (const headers of [{}, { Authorization: "Bearer not-the-token-not-the-token" }]) {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  }, 40_000);

  it("drains and restores a replica within 1s, and explains the drain as an operator action", async () => {
    const { registry, decisionLog, statusUrl } = await boot();

    // Before: round-robin spreads over all three.
    const before = await routeMany(statusUrl, 9);
    expect(new Set(before.map((r) => r.replicaId))).toEqual(
      new Set(["replica-1", "replica-2", "replica-3"]),
    );

    // Drain. The change must be visible through every surface within 1s.
    const t0 = performance.now();
    const drained = await call<ActionResult<ReplicaAdminState>>("drain_replica", {
      replica_id: "replica-2",
    });
    const viaTool = await call<ToolResult<RegistrySnapshot>>("get_fleet_status", {});
    const viaHttp = await fleetStatus(statusUrl);
    expect(performance.now() - t0).toBeLessThan(REFLECT_MS);

    expect(drained.isError).toBe(false);
    expect(drained.result).toMatchObject({
      ok: true,
      changed: true,
      before: { admin: "active", routableReplicas: 3 },
      after: { replicaId: "replica-2", admin: "drained", routable: false, routableReplicas: 2 },
    });
    expect(viaTool.result.ok).toBe(true);
    for (const snap of [viaTool.result.ok ? viaTool.result.data : undefined, viaHttp]) {
      expect(snap?.replicas.find((r) => r.id === "replica-2")?.admin).toBe("drained");
      expect(snap?.replicas.find((r) => r.id === "replica-1")?.admin).toBe("active");
    }

    // No request after the drain lands on the drained replica, and none fail.
    const during = await routeMany(statusUrl, 12);
    expect(during.every((r) => r.httpStatus === 200)).toBe(true);
    expect(during.map((r) => r.replicaId)).not.toContain("replica-2");
    expect(new Set(during.map((r) => r.replicaId))).toEqual(new Set(["replica-1", "replica-3"]));

    // The tool's answer matches what the registry holds (read back, not echoed).
    expect(registry.getSnapshot().replicas.find((r) => r.id === "replica-2")?.admin).toBe(
      "drained",
    );

    // The decision for a post-drain request cites the drain, never a health fault.
    const decision = decisionLog.get(during[0]!.requestId)!;
    expect(decision.rounds[0]!.excluded).toEqual([{ replicaId: "replica-2", reason: "drained" }]);
    const explained = await call<ToolResult<ExplainRoutingDecisionData>>(
      "explain_routing_decision",
      { request_id: during[0]!.requestId },
    );
    expect(explained.result.ok).toBe(true);
    if (!explained.result.ok) return;
    const roundLine = explained.result.data.lines[1]!.text;
    expect(roundLine).toContain("replica-2 (drained by operator)");
    expect(roundLine).not.toContain("unhealthy");

    // A repeat drain is a successful no-op, not an error.
    const again = await call<ActionResult<ReplicaAdminState>>("drain_replica", {
      replica_id: "replica-2",
    });
    expect(again.isError).toBe(false);
    expect(again.result).toMatchObject({ ok: true, changed: false });

    // The health scheduler keeps polling the drained replica; it must stay drained.
    await sleep(800);
    expect((await fleetStatus(statusUrl)).replicas.find((r) => r.id === "replica-2")).toMatchObject(
      { admin: "drained", runtime: { health: "healthy" } },
    );

    // Restore: traffic resumes within 1s.
    const t1 = performance.now();
    const restored = await call<ActionResult<ReplicaAdminState>>("restore_replica", {
      replica_id: "replica-2",
    });
    const resumed = await routeMany(statusUrl, 9);
    expect(performance.now() - t1).toBeLessThan(REFLECT_MS);
    expect(restored.result).toMatchObject({
      ok: true,
      changed: true,
      after: { admin: "active", routable: true, routableReplicas: 3 },
    });
    expect(new Set(resumed.map((r) => r.replicaId))).toEqual(
      new Set(["replica-1", "replica-2", "replica-3"]),
    );

    // An unknown replica is an error and changes nothing.
    const unknown = await call<ActionResult<ReplicaAdminState>>("drain_replica", {
      replica_id: "replica-9",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.result).toMatchObject({ ok: false, code: "unknown_replica" });
  }, 60_000);

  it("changes the routing strategy and weights live, and rejects bad input without changing state", async () => {
    const { routingConfig, decisionLog, statusUrl } = await boot("round-robin");

    const t0 = performance.now();
    const swapped = await call<ActionResult<{ strategy: string }>>("set_routing_strategy", {
      strategy: "least-loaded",
    });
    // The very next request is routed by the new strategy and recorded as such.
    const next = await route(statusUrl);
    expect(performance.now() - t0).toBeLessThan(REFLECT_MS);

    expect(swapped.result).toMatchObject({
      ok: true,
      changed: true,
      before: { strategy: "round-robin" },
      after: { strategy: "least-loaded" },
    });
    expect(routingConfig.getStrategyName()).toBe("least-loaded");
    expect(next.strategy).toBe("least-loaded");
    expect(decisionLog.get(next.requestId)!.rounds[0]!.strategy).toBe("least-loaded");

    // An unknown strategy is an error, lists the valid names, and leaves state alone.
    const bad = await call<ActionResult<unknown>>("set_routing_strategy", { strategy: "random" });
    expect(bad.isError).toBe(true);
    expect(bad.result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(JSON.stringify(bad.result)).toContain("round-robin");
    expect(routingConfig.getStrategyName()).toBe("least-loaded");

    // Weights under a strategy that ignores them succeed with a note saying so.
    const ignored = await call<ActionResult<{ loadWeight: number; latencyWeight: number }>>(
      "set_scoring_weights",
      { load_weight: 2, latency_weight: 0.5 },
    );
    expect(ignored.result).toMatchObject({
      ok: true,
      changed: true,
      after: { loadWeight: 2, latencyWeight: 0.5 },
    });
    expect(ignored.result.ok && ignored.result.notes?.join(" ")).toMatch(/least-loaded/);
    expect(routingConfig.getWeights()).toEqual({ loadWeight: 2, latencyWeight: 0.5 });

    // Under latency-weighted the same call carries no note.
    await call("set_routing_strategy", { strategy: "latency-weighted" });
    const used = await call<ActionResult<unknown>>("set_scoring_weights", {
      load_weight: 1,
      latency_weight: 3,
    });
    expect(used.result.ok && used.result.notes).toBeUndefined();
    expect(routingConfig.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 3 });

    // A negative weight is rejected and the stored weights are untouched.
    const negative = await call<ActionResult<unknown>>("set_scoring_weights", {
      load_weight: -1,
      latency_weight: 3,
    });
    expect(negative.isError).toBe(true);
    expect(negative.result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(routingConfig.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 3 });
  }, 40_000);

  it("injects a failure, fails over with no failed request, and clears it with revive", async () => {
    const { statusUrl } = await boot("round-robin");

    const killed = await call<ActionResult<{ killed: boolean; inferFailing: boolean }>>(
      "simulate_failure",
      { replica_id: "replica-3", mode: "kill" },
    );
    expect(killed.isError).toBe(false);
    // Read back from the replica itself. There is no `before`, so `changed` is null, not a guess.
    expect(killed.result).toMatchObject({ ok: true, changed: null, after: { killed: true } });
    expect(killed.result.ok && "before" in killed.result).toBe(false);
    expect(killed.result.ok && killed.result.notes?.join(" ")).toMatch(/1\.5 seconds/);

    // Traffic keeps succeeding while the fleet notices (retry on a survivor).
    const during = await routeMany(statusUrl, 8);
    expect(during.every((r) => r.httpStatus === 200)).toBe(true);

    await waitForHealth(statusUrl, "replica-3", "unhealthy");
    const afterEject = await routeMany(statusUrl, 6);
    expect(afterEject.every((r) => r.httpStatus === 200)).toBe(true);
    expect(afterEject.map((r) => r.replicaId)).not.toContain("replica-3");

    const revived = await call<ActionResult<{ killed: boolean; inferFailing: boolean }>>(
      "simulate_failure",
      { replica_id: "replica-3", mode: "revive" },
    );
    expect(revived.result).toMatchObject({
      ok: true,
      after: { killed: false, inferFailing: false },
    });
    await waitForHealth(statusUrl, "replica-3", "healthy");

    // Bad mode and unknown replica are errors.
    const badMode = await call<ActionResult<unknown>>("simulate_failure", {
      replica_id: "replica-3",
      mode: "explode",
    });
    expect(badMode.isError).toBe(true);
    expect(badMode.result).toMatchObject({ ok: false, code: "invalid_input" });
    const unknown = await call<ActionResult<unknown>>("simulate_failure", {
      replica_id: "replica-9",
    });
    expect(unknown.result).toMatchObject({ ok: false, code: "unknown_replica" });
  }, 60_000);
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

async function waitForHealth(
  statusUrl: string,
  id: string,
  health: "healthy" | "unhealthy",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snap = await fleetStatus(statusUrl);
    if (snap.replicas.find((r) => r.id === id)?.runtime.health === health) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id} to become ${health}`);
    await sleep(25);
  }
}
