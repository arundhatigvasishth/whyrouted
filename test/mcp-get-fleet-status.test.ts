import { afterEach, describe, expect, it } from "vitest";
import { startStatusServer, type RunningStatusServer } from "../src/api/server.js";
import { Registry } from "../src/registry/registry.js";
import { createGetFleetStatusTool } from "../src/mcp/tools/get-fleet-status.js";
import type { RegistrySnapshot } from "../src/types.js";

function seeded(): Registry {
  const reg = new Registry();
  reg.register({ id: "replica-1", url: "http://127.0.0.1:8001" });
  reg.register({ id: "replica-2", url: "http://127.0.0.1:8002" });
  reg.updateRuntime("replica-1", { inFlight: 3, latencyMs: 12 });
  reg.setHealth("replica-1", "healthy");
  reg.setHealth("replica-2", "unhealthy");
  return reg;
}

let running: RunningStatusServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("get_fleet_status", () => {
  it("is named and described for the MCP client, and takes no arguments", () => {
    const tool = createGetFleetStatusTool(new Registry());
    expect(tool.name).toBe("get_fleet_status");
    expect(tool.description).toMatch(/replica/);
    expect(tool.inputSchema).toEqual({});
  });

  it("returns the registry snapshot verbatim, grounded in the registry", async () => {
    const reg = seeded();
    const res = await createGetFleetStatusTool(reg).call({});

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as RegistrySnapshot;
    expect(data.replicas).toEqual(reg.getSnapshot().replicas);
    expect(data.replicas.map((r) => r.id)).toEqual(["replica-1", "replica-2"]);
    expect(res.groundedIn.source).toBe("registry");
    expect(res.groundedIn.recordIds).toEqual(["replica-1", "replica-2"]);
    expect(res.groundedIn.queriedAt).toBe(new Date(res.groundedIn.queriedAt).toISOString());
  });

  it("reports health and load as the registry has them right now", async () => {
    const reg = seeded();
    const tool = createGetFleetStatusTool(reg);

    reg.setHealth("replica-2", "healthy");
    reg.updateRuntime("replica-2", { inFlight: 7 });
    const res = await tool.call({});

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const second = (res.data as RegistrySnapshot).replicas.find((r) => r.id === "replica-2");
    expect(second?.runtime.health).toBe("healthy");
    expect(second?.runtime.inFlight).toBe(7);
  });

  it("matches what GET /status serves", async () => {
    const reg = seeded();
    running = await startStatusServer({ store: reg, port: 0 });
    const http = (await (await fetch(`${running.url}/status`)).json()) as RegistrySnapshot;

    const res = await createGetFleetStatusTool(reg).call({});
    expect(res.ok && (res.data as RegistrySnapshot).replicas).toEqual(http.replicas);
  });

  it("says so when the registry is empty instead of returning an empty fleet", async () => {
    const res = await createGetFleetStatusTool(new Registry()).call({});
    expect(res).toEqual({
      ok: false,
      code: "no_data",
      reason: "the registry has no replicas registered",
    });
  });
});
