import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry/registry.js";
import { createRoutingConfig } from "../src/routing/config.js";
import { createRoutingEngine } from "../src/routing/engine.js";
import { DEFAULT_SCORING_WEIGHTS } from "../src/routing/types.js";
import type { ActionResult } from "../src/mcp/action.js";
import type { ReplicaAdminState } from "../src/mcp/tools/replica-admin.js";
import { createDrainReplicaTool } from "../src/mcp/tools/drain-replica.js";
import { createRestoreReplicaTool } from "../src/mcp/tools/restore-replica.js";
import { toActionCallToolResult } from "../src/mcp/server.js";

type Result = ActionResult<ReplicaAdminState>;

function fleet(health: Record<string, "healthy" | "unhealthy"> = {}) {
  const registry = new Registry();
  for (const id of ["replica-1", "replica-2", "replica-3"]) {
    registry.register({ id, url: `http://127.0.0.1/${id}` });
    registry.setHealth(id, health[id] ?? "healthy");
  }
  return {
    registry,
    drain: createDrainReplicaTool(registry),
    restore: createRestoreReplicaTool(registry),
  };
}

const run = async (tool: { call: (a: unknown) => Promise<unknown> }, id: string): Promise<Result> =>
  (await tool.call({ replica_id: id })) as Result;

const adminOf = (registry: Registry, id: string) =>
  registry.getSnapshot().replicas.find((r) => r.id === id)!.admin;

describe("drain_replica", () => {
  it("drains a replica and reports before and after read back from the registry", async () => {
    const { registry, drain } = fleet();
    const r = await run(drain, "replica-2");

    expect(r).toMatchObject({
      ok: true,
      changed: true,
      before: { replicaId: "replica-2", admin: "active", routable: true, routableReplicas: 3 },
      after: {
        replicaId: "replica-2",
        admin: "drained",
        health: "healthy",
        routable: false,
        routableReplicas: 2,
      },
    });
    expect(adminOf(registry, "replica-2")).toBe("drained");
    expect(adminOf(registry, "replica-1")).toBe("active");
  });

  it("is a successful no-op on an already drained replica", async () => {
    const { drain } = fleet();
    await run(drain, "replica-2");
    const r = await run(drain, "replica-2");

    expect(r).toMatchObject({ ok: true, changed: false });
    expect(toActionCallToolResult(r).isError).toBe(false);
  });

  it("reports an unknown id and changes nothing", async () => {
    const { registry, drain } = fleet();
    const before = registry.getSnapshot().replicas;
    const r = await run(drain, "replica-9");

    expect(r).toMatchObject({ ok: false, code: "unknown_replica" });
    expect(r.ok === false && r.reason).toContain("replica-9");
    expect(registry.getSnapshot().replicas).toEqual(before);
  });

  it("allows draining the last routable replica and says the fleet cannot route", async () => {
    const { drain } = fleet({ "replica-2": "unhealthy", "replica-3": "unhealthy" });
    const r = await run(drain, "replica-1");

    expect(r).toMatchObject({ ok: true, changed: true, after: { routableReplicas: 0 } });
    expect(r.ok && r.notes?.join(" ")).toMatch(/no replica is routable/);
  });

  it("leaves no note when other replicas remain routable", async () => {
    const { drain } = fleet();
    const r = await run(drain, "replica-1");
    expect(r.ok && r.notes).toBeUndefined();
  });

  it("drains a replica that is also unhealthy", async () => {
    const { registry, drain } = fleet({ "replica-2": "unhealthy" });
    const r = await run(drain, "replica-2");

    expect(r).toMatchObject({ ok: true, changed: true, after: { admin: "drained" } });
    expect(adminOf(registry, "replica-2")).toBe("drained");
  });
});

describe("restore_replica", () => {
  it("returns a drained replica to the pool", async () => {
    const { registry, drain, restore } = fleet();
    await run(drain, "replica-2");
    const r = await run(restore, "replica-2");

    expect(r).toMatchObject({
      ok: true,
      changed: true,
      before: { admin: "drained", routable: false, routableReplicas: 2 },
      after: { admin: "active", routable: true, routableReplicas: 3 },
    });
    expect(r.ok && r.notes).toBeUndefined();
    expect(adminOf(registry, "replica-2")).toBe("active");
  });

  it("is a successful no-op on an active replica", async () => {
    const { restore } = fleet();
    const r = await run(restore, "replica-1");
    expect(r).toMatchObject({ ok: true, changed: false });
  });

  it("does not claim an unhealthy replica is back in rotation", async () => {
    const { drain, restore } = fleet({ "replica-2": "unhealthy" });
    await run(drain, "replica-2");
    const r = await run(restore, "replica-2");

    expect(r).toMatchObject({
      ok: true,
      changed: true,
      after: { admin: "active", health: "unhealthy", routable: false },
    });
    expect(r.ok && r.notes?.join(" ")).toMatch(/still not routable.*unhealthy/);
  });

  it("reports an unknown id and changes nothing", async () => {
    const { restore } = fleet();
    expect(await run(restore, "nope")).toMatchObject({ ok: false, code: "unknown_replica" });
  });
});

describe("drain and restore against the routing engine", () => {
  it("sends no new traffic to a drained replica, and resumes after restore", async () => {
    const { registry, drain, restore } = fleet();
    const engine = createRoutingEngine({
      registry,
      config: createRoutingConfig({
        strategy: "round-robin",
        weights: DEFAULT_SCORING_WEIGHTS,
      }),
    });
    const picks = () =>
      Array.from({ length: 12 }, () => {
        const r = engine.route();
        return r.ok ? r.replicaId : "none";
      });

    expect(new Set(picks())).toEqual(new Set(["replica-1", "replica-2", "replica-3"]));

    await run(drain, "replica-2");
    expect(new Set(picks())).toEqual(new Set(["replica-1", "replica-3"]));

    await run(restore, "replica-2");
    expect(new Set(picks())).toEqual(new Set(["replica-1", "replica-2", "replica-3"]));
  });
});
