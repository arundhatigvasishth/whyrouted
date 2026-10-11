import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Registry } from "../src/registry/registry.js";
import { createRoutingConfig } from "../src/routing/config.js";
import { createRoutingEngine } from "../src/routing/engine.js";
import { startMcpServer, type RunningMcpServer } from "../src/mcp/server.js";
import { createActionTools } from "../src/mcp/tools/index.js";
import { createSetRoutingStrategyTool } from "../src/mcp/tools/set-routing-strategy.js";
import { createSetScoringWeightsTool } from "../src/mcp/tools/set-scoring-weights.js";
import type { ActionResult } from "../src/mcp/action.js";
import type { StrategyName } from "../src/routing/types.js";

function config(strategy: StrategyName = "least-loaded", loadWeight = 1, latencyWeight = 1) {
  return createRoutingConfig({ strategy, weights: { loadWeight, latencyWeight } });
}

describe("set_routing_strategy", () => {
  it("is named and described for the MCP client, and lists the valid strategies", () => {
    const tool = createSetRoutingStrategyTool(config());
    expect(tool.kind).toBe("action");
    expect(tool.name).toBe("set_routing_strategy");
    for (const name of ["round-robin", "least-loaded", "latency-weighted"]) {
      expect(tool.description).toContain(name);
    }
  });

  it("swaps the strategy and reports before and after read back from the config", async () => {
    const cfg = config("least-loaded");
    const res = await createSetRoutingStrategyTool(cfg).call({ strategy: "round-robin" });
    expect(res).toMatchObject({
      ok: true,
      changed: true,
      before: { strategy: "least-loaded" },
      after: { strategy: "round-robin" },
    });
    expect(cfg.getStrategyName()).toBe("round-robin");
  });

  it("accepts every valid strategy", async () => {
    for (const name of ["round-robin", "least-loaded", "latency-weighted"] as const) {
      const cfg = config(name === "round-robin" ? "least-loaded" : "round-robin");
      const res = await createSetRoutingStrategyTool(cfg).call({ strategy: name });
      expect(res.ok, name).toBe(true);
      expect(cfg.getStrategyName()).toBe(name);
    }
  });

  it("reports setting the strategy that is already active as a success with changed: false", async () => {
    const cfg = config("least-loaded");
    const res = await createSetRoutingStrategyTool(cfg).call({ strategy: "least-loaded" });
    expect(res).toMatchObject({ ok: true, changed: false });
    expect(cfg.getStrategyName()).toBe("least-loaded");
  });

  it("rejects an unknown strategy, listing the valid ones, and changes nothing", async () => {
    const cfg = config("least-loaded");
    const res = await createSetRoutingStrategyTool(cfg).call({ strategy: "fastest" });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(res.ok === false && res.reason).toMatch(
      /"fastest".*round-robin, least-loaded, latency-weighted/,
    );
    expect(cfg.getStrategyName()).toBe("least-loaded");
  });

  it("treats a differently cased or padded name as unknown, not a guess", async () => {
    const cfg = config("least-loaded");
    for (const bad of ["Round-Robin", " round-robin", "", "round_robin"]) {
      expect((await createSetRoutingStrategyTool(cfg).call({ strategy: bad })).ok, bad).toBe(false);
    }
    expect(cfg.getStrategyName()).toBe("least-loaded");
  });

  it("changes what the router actually does on its very next request", async () => {
    const registry = new Registry();
    registry.register({ id: "replica-1", url: "http://127.0.0.1:1" });
    registry.setHealth("replica-1", "healthy");
    const cfg = config("least-loaded");
    const engine = createRoutingEngine({ registry, config: cfg });

    expect(engine.route()).toMatchObject({ ok: true, strategy: "least-loaded" });
    await createSetRoutingStrategyTool(cfg).call({ strategy: "round-robin" });
    expect(engine.route()).toMatchObject({ ok: true, strategy: "round-robin" });
  });
});

describe("set_scoring_weights", () => {
  it("takes load_weight and latency_weight", () => {
    const tool = createSetScoringWeightsTool(config());
    expect(tool.kind).toBe("action");
    expect(tool.name).toBe("set_scoring_weights");
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["latency_weight", "load_weight"]);
  });

  it("retunes the weights and reports before and after read back from the config", async () => {
    const cfg = config("latency-weighted", 1, 1);
    const res = await createSetScoringWeightsTool(cfg).call({
      load_weight: 2,
      latency_weight: 0.5,
    });
    expect(res).toMatchObject({
      ok: true,
      changed: true,
      before: { loadWeight: 1, latencyWeight: 1 },
      after: { loadWeight: 2, latencyWeight: 0.5 },
    });
    expect(cfg.getWeights()).toEqual({ loadWeight: 2, latencyWeight: 0.5 });
  });

  it("reports setting the same weights as a success with changed: false", async () => {
    const cfg = config("latency-weighted", 1, 1);
    const res = await createSetScoringWeightsTool(cfg).call({ load_weight: 1, latency_weight: 1 });
    expect(res).toMatchObject({ ok: true, changed: false });
  });

  it("accepts zero for either weight", async () => {
    const cfg = config("latency-weighted");
    const res = await createSetScoringWeightsTool(cfg).call({ load_weight: 0, latency_weight: 3 });
    expect(res.ok).toBe(true);
    expect(cfg.getWeights()).toEqual({ loadWeight: 0, latencyWeight: 3 });
  });

  it("rejects negative and non-finite weights as invalid_input and changes nothing", async () => {
    const cfg = config("latency-weighted", 1, 1);
    const tool = createSetScoringWeightsTool(cfg);
    for (const args of [
      { load_weight: -1, latency_weight: 1 },
      { load_weight: 1, latency_weight: -0.1 },
      { load_weight: Number.NaN, latency_weight: 1 },
      { load_weight: 1, latency_weight: Number.POSITIVE_INFINITY },
    ]) {
      const res = await tool.call(args);
      expect(res, JSON.stringify(args)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(cfg.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });

  it("adds no note when latency-weighted is active, because the weights take effect", async () => {
    const res = await createSetScoringWeightsTool(config("latency-weighted")).call({
      load_weight: 2,
      latency_weight: 1,
    });
    expect(res.ok && "notes" in res).toBe(false);
  });

  it("warns that the weights are stored but unused under least-loaded and round-robin", async () => {
    for (const strategy of ["least-loaded", "round-robin"] as const) {
      const res = await createSetScoringWeightsTool(config(strategy)).call({
        load_weight: 2,
        latency_weight: 1,
      });
      expect(res.ok, strategy).toBe(true);
      expect(res.ok && res.notes?.[0], strategy).toMatch(
        new RegExp(`${strategy}.*does not use scoring weights.*latency-weighted`),
      );
    }
  });

  it("changes which replica latency-weighted picks on the very next request", async () => {
    const registry = new Registry();
    registry.register({ id: "idle-slow", url: "http://127.0.0.1:1" });
    registry.register({ id: "busy-fast", url: "http://127.0.0.1:2" });
    for (const id of ["idle-slow", "busy-fast"]) registry.setHealth(id, "healthy");
    registry.updateRuntime("idle-slow", { inFlight: 0, latencyMs: 100 });
    registry.updateRuntime("busy-fast", { inFlight: 5, latencyMs: 1 });

    const cfg = config("latency-weighted", 1, 1);
    const engine = createRoutingEngine({ registry, config: cfg });
    const tool = createSetScoringWeightsTool(cfg);

    // Load only: the idle replica wins.
    await tool.call({ load_weight: 1, latency_weight: 0 });
    expect(engine.route()).toMatchObject({ ok: true, replicaId: "idle-slow" });
    // Latency only: the fast replica wins.
    await tool.call({ load_weight: 0, latency_weight: 1 });
    expect(engine.route()).toMatchObject({ ok: true, replicaId: "busy-fast" });
  });
});

describe("routing config tools over MCP", () => {
  let running: RunningMcpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await running?.close();
    client = undefined;
    running = undefined;
  });

  async function connect(cfg = config("least-loaded")) {
    running = await startMcpServer({
      tools: createActionTools({ routingConfig: cfg }),
      port: 0,
    });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    return { client, cfg };
  }

  const parse = <S>(res: Awaited<ReturnType<Client["callTool"]>>) =>
    JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as ActionResult<S>;

  it("lists both tools", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "set_routing_strategy",
      "set_scoring_weights",
    ]);
  });

  it("applies a strategy change through the protocol and flags a bad one as an error", async () => {
    const { client, cfg } = await connect();
    const ok = await client.callTool({
      name: "set_routing_strategy",
      arguments: { strategy: "latency-weighted" },
    });
    expect(ok.isError).toBe(false);
    expect(parse(ok)).toMatchObject({ ok: true, changed: true });
    expect(cfg.getStrategyName()).toBe("latency-weighted");

    const bad = await client.callTool({
      name: "set_routing_strategy",
      arguments: { strategy: "fastest" },
    });
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(cfg.getStrategyName()).toBe("latency-weighted");
  });

  it("applies weights through the protocol, with the note, and flags a negative one as an error", async () => {
    const { client, cfg } = await connect();
    const ok = await client.callTool({
      name: "set_scoring_weights",
      arguments: { load_weight: 3, latency_weight: 2 },
    });
    expect(ok.isError).toBe(false);
    const body = parse<{ loadWeight: number }>(ok);
    expect(body).toMatchObject({ ok: true, changed: true, after: { loadWeight: 3 } });
    expect(body.ok && body.notes).toHaveLength(1);
    expect(cfg.getWeights()).toEqual({ loadWeight: 3, latencyWeight: 2 });

    const bad = await client.callTool({
      name: "set_scoring_weights",
      arguments: { load_weight: -3, latency_weight: 2 },
    });
    expect(bad.isError).toBe(true);
    expect(cfg.getWeights()).toEqual({ loadWeight: 3, latencyWeight: 2 });
  });

  it("rejects a non-number weight before the handler runs, leaving the weights alone", async () => {
    const { client, cfg } = await connect();
    const res = await client
      .callTool({
        name: "set_scoring_weights",
        arguments: { load_weight: "heavy", latency_weight: 1 },
      })
      .catch((e: unknown) => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    expect(cfg.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });
});
