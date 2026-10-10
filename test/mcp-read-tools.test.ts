import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFailoverLog } from "../src/events/failover-log.js";
import { Registry } from "../src/registry/registry.js";
import { startMcpServer, type RunningMcpServer } from "../src/mcp/server.js";
import { createReadTools } from "../src/mcp/tools/index.js";
import type { ToolResult } from "../src/mcp/types.js";

// M5b's action tools. None of them may be registered by M5a.
const ACTION_TOOLS = [
  "drain_replica",
  "restore_replica",
  "simulate_failure",
  "set_routing_strategy",
  "set_scoring_weights",
];

let running: RunningMcpServer | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = undefined;
  running = undefined;
});

async function boot() {
  const registry = new Registry();
  registry.register({ id: "replica-1", url: "http://127.0.0.1:8001" });
  registry.setHealth("replica-1", "healthy");
  const failoverLog = createFailoverLog({ unhealthyThreshold: 3, healthyThreshold: 2 });
  failoverLog.record({
    id: "e1",
    replicaId: "replica-1",
    kind: "ejected",
    at: "2026-10-10T11:00:00.000Z",
    trigger: "health_check",
    reason: "3 consecutive failed probes",
  });

  running = await startMcpServer({ tools: createReadTools({ registry, failoverLog }), port: 0 });
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
  return { registry, failoverLog, client };
}

function parse(res: Awaited<ReturnType<Client["callTool"]>>): ToolResult<unknown> {
  const content = res.content as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as ToolResult<unknown>;
}

describe("read tools over MCP", () => {
  it("registers the state tools and no M5b action tool", async () => {
    const { client } = await boot();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_fleet_status", "get_failover_history"]));
    for (const action of ACTION_TOOLS) expect(names).not.toContain(action);
  });

  it("serves live registry state through get_fleet_status", async () => {
    const { client, registry } = await boot();
    registry.updateRuntime("replica-1", { inFlight: 4 });

    const res = parse(await client.callTool({ name: "get_fleet_status", arguments: {} }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.groundedIn).toMatchObject({ source: "registry", recordIds: ["replica-1"] });
    const replicas = (res.data as { replicas: Array<{ runtime: { inFlight: number } }> }).replicas;
    expect(replicas[0]?.runtime.inFlight).toBe(4);
  });

  it("serves recorded events through get_failover_history", async () => {
    const { client } = await boot();
    const res = parse(
      await client.callTool({
        name: "get_failover_history",
        arguments: { from: "2026-10-10T10:00:00Z" },
      }),
    );
    expect(res.ok && res.groundedIn).toMatchObject({ source: "failover_log", recordIds: ["e1"] });
  });

  it("reports a window with no events as no_data over the wire", async () => {
    const { client } = await boot();
    const raw = await client.callTool({
      name: "get_failover_history",
      arguments: { from: "2027-01-01T00:00:00Z" },
    });
    expect(raw.isError).toBe(false);
    expect(parse(raw)).toMatchObject({ ok: false, code: "no_data" });
  });
});
