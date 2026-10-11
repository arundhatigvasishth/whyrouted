import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Registry } from "../src/registry/registry.js";
import { startReplica, type RunningReplica } from "../src/replica/server.js";
import {
  createHttpFaultInjector,
  type FaultInjector,
  type FaultMode,
} from "../src/replica/fault-injector.js";
import { startMcpServer, type RunningMcpServer } from "../src/mcp/server.js";
import { createSimulateFailureTool } from "../src/mcp/tools/simulate-failure.js";
import type { ActionResult } from "../src/mcp/action.js";

function registryWith(...ids: string[]): Registry {
  const reg = new Registry();
  for (const id of ids) reg.register({ id, url: `http://127.0.0.1:1/${id}` });
  return reg;
}

/** An injector that records its calls and reports a state derived from the last mode. */
function fakeInjector() {
  const calls: Array<{ replicaId: string; mode: FaultMode }> = [];
  const injector: FaultInjector = {
    inject: async (replicaId, mode) => {
      calls.push({ replicaId, mode });
      return { killed: mode === "kill", inferFailing: mode === "fail_infer" };
    },
  };
  return { calls, injector };
}

describe("simulate_failure", () => {
  it("is named for the MCP client, defaults to kill, and lists the modes", () => {
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1") });
    expect(tool.kind).toBe("action");
    expect(tool.name).toBe("simulate_failure");
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["mode", "replica_id"]);
    for (const mode of ["kill", "fail_infer", "revive"]) expect(tool.description).toContain(mode);
  });

  it("kills by default and reports the state the replica returned", async () => {
    const { calls, injector } = fakeInjector();
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1"), injector });
    const res = await tool.call({ replica_id: "replica-1" });
    expect(calls).toEqual([{ replicaId: "replica-1", mode: "kill" }]);
    expect(res).toMatchObject({ ok: true, after: { killed: true, inferFailing: false } });
  });

  it("has no before and a null changed, because the prior state cannot be read", async () => {
    const { injector } = fakeInjector();
    const res = await createSimulateFailureTool({
      registry: registryWith("replica-1"),
      injector,
    }).call({ replica_id: "replica-1", mode: "kill" });
    expect(res.ok && res.changed).toBeNull();
    expect(res.ok && "before" in res).toBe(false);
  });

  it("supports fail_infer and revive", async () => {
    const { calls, injector } = fakeInjector();
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1"), injector });
    const a = await tool.call({ replica_id: "replica-1", mode: "fail_infer" });
    expect(a).toMatchObject({ ok: true, after: { killed: false, inferFailing: true } });
    const b = await tool.call({ replica_id: "replica-1", mode: "revive" });
    expect(b).toMatchObject({ ok: true, after: { killed: false, inferFailing: false } });
    expect(calls.map((c) => c.mode)).toEqual(["fail_infer", "revive"]);
  });

  it("does not claim the replica is now unhealthy, and points at get_fleet_status", async () => {
    const { injector } = fakeInjector();
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1"), injector });
    const res = await tool.call({ replica_id: "replica-1", mode: "kill" });
    expect(res.ok && res.notes?.[0]).toMatch(/get_fleet_status/);
    expect(JSON.stringify(res)).not.toMatch(/"health"/);
  });

  it("rejects an unknown mode, listing the valid ones, without touching the replica", async () => {
    const { calls, injector } = fakeInjector();
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1"), injector });
    const res = await tool.call({ replica_id: "replica-1", mode: "explode" });
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(res.ok === false && res.reason).toMatch(/"explode".*kill, fail_infer, revive/);
    expect(calls).toEqual([]);
  });

  it("rejects an unknown replica before any network call", async () => {
    const { calls, injector } = fakeInjector();
    const tool = createSimulateFailureTool({ registry: registryWith("replica-1"), injector });
    const res = await tool.call({ replica_id: "replica-9" });
    expect(res).toMatchObject({ ok: false, code: "unknown_replica" });
    expect(calls).toEqual([]);
  });

  it("returns unsupported, not ok, when no injector is wired", async () => {
    const res = await createSimulateFailureTool({ registry: registryWith("replica-1") }).call({
      replica_id: "replica-1",
    });
    expect(res).toMatchObject({ ok: false, code: "unsupported" });
    expect(res.ok === false && res.reason).toMatch(/not a simulated fleet/);
  });

  it("reports an unreachable replica as internal_error with the reason, not as a state", async () => {
    const injector: FaultInjector = {
      inject: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const res = await createSimulateFailureTool({
      registry: registryWith("replica-1"),
      injector,
    }).call({ replica_id: "replica-1" });
    expect(res).toMatchObject({ ok: false, code: "internal_error" });
    expect(res.ok === false && res.reason).toMatch(
      /could not inject kill into replica-1: connect ECONNREFUSED/,
    );
  });
});

describe("simulate_failure against a real simulated replica, over MCP", () => {
  let replica: RunningReplica | undefined;
  let server: RunningMcpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await replica?.close();
    client = server = undefined;
    replica = undefined;
  });

  it("kills the replica for real, reports its state, and revive undoes it", async () => {
    replica = await startReplica({
      id: "replica-1",
      port: 0,
      profile: { baseLatencyMs: 5, latencyJitterMs: 0, loadAmplitude: 0, periodMs: 20_000 },
    });
    const registry = new Registry();
    registry.register({ id: "replica-1", url: replica.url });
    const injector = createHttpFaultInjector({ replicas: [{ id: "replica-1", url: replica.url }] });

    server = await startMcpServer({
      tools: [createSimulateFailureTool({ registry, injector })],
      port: 0,
    });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

    const call = async (args: Record<string, unknown>) => {
      const raw = await client!.callTool({ name: "simulate_failure", arguments: args });
      const body = JSON.parse(
        (raw.content as Array<{ text: string }>)[0]!.text,
      ) as ActionResult<unknown>;
      return { raw, body };
    };

    const killed = await call({ replica_id: "replica-1" });
    expect(killed.raw.isError).toBe(false);
    expect(killed.body).toMatchObject({ ok: true, after: { killed: true, inferFailing: false } });
    // The effect is real, not just reported: the replica now fails.
    expect((await fetch(`${replica.url}/health`)).status).toBe(503);

    const revived = await call({ replica_id: "replica-1", mode: "revive" });
    expect(revived.body).toMatchObject({ ok: true, after: { killed: false, inferFailing: false } });
    expect((await fetch(`${replica.url}/health`)).status).toBe(200);

    const unknown = await call({ replica_id: "replica-9" });
    expect(unknown.raw.isError).toBe(true);
    expect(unknown.body).toMatchObject({ ok: false, code: "unknown_replica" });
  });
});
