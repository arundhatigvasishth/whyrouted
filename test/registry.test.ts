import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry/registry.js";
import { initialRuntime } from "../src/types.js";

const replica = (id: string, url = `http://127.0.0.1:${8000 + Number(id.split("-")[1])}`) => ({
  id,
  url,
});

describe("Registry.register", () => {
  it("adds a replica with the initial runtime", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));

    const snap = reg.getSnapshot();
    expect(snap.replicas).toHaveLength(1);
    expect(snap.replicas[0]).toEqual({
      id: "replica-1",
      url: "http://127.0.0.1:8001",
      runtime: initialRuntime(),
    });
  });

  it("throws on a duplicate id", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));
    expect(() => reg.register(replica("replica-1"))).toThrow(/already registered/);
  });
});

describe("Registry.updateRuntime", () => {
  it("merges a partial patch, leaving other fields untouched", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));

    reg.updateRuntime("replica-1", { inFlight: 3, latencyMs: 12, consecSuccesses: 1 });
    reg.updateRuntime("replica-1", { inFlight: 5, lastCheckedAt: "2026-09-01T00:00:00.000Z" });

    const { runtime } = reg.getSnapshot().replicas[0]!;
    expect(runtime).toEqual({
      health: "unknown",
      inFlight: 5,
      latencyMs: 12,
      consecFailures: 0,
      consecSuccesses: 1,
      lastCheckedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("throws on an unknown id", () => {
    const reg = new Registry();
    expect(() => reg.updateRuntime("replica-9", { inFlight: 1 })).toThrow(/not registered/);
  });
});

describe("Registry.setHealth", () => {
  it("changes only the health field and persists across snapshots", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));

    reg.setHealth("replica-1", "unhealthy");
    expect(reg.getSnapshot().replicas[0]!.runtime.health).toBe("unhealthy");

    reg.setHealth("replica-1", "healthy");
    expect(reg.getSnapshot().replicas[0]!.runtime.health).toBe("healthy");
  });

  it("throws on an unknown id", () => {
    const reg = new Registry();
    expect(() => reg.setHealth("replica-9", "healthy")).toThrow(/not registered/);
  });
});

describe("Registry.getSnapshot", () => {
  it("lists replicas in registration order", () => {
    const reg = new Registry();
    reg.register(replica("replica-3"));
    reg.register(replica("replica-1"));
    reg.register(replica("replica-2"));

    expect(reg.getSnapshot().replicas.map((r) => r.id)).toEqual([
      "replica-3",
      "replica-1",
      "replica-2",
    ]);
  });

  it("stamps generatedAt as an ISO 8601 string", () => {
    const reg = new Registry();
    const before = Date.now();
    const { generatedAt } = reg.getSnapshot();
    const after = Date.now();

    const t = Date.parse(generatedAt);
    expect(generatedAt).toBe(new Date(t).toISOString());
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("returns copies — mutating the result does not change registry state", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));

    const snap = reg.getSnapshot();
    snap.replicas[0]!.runtime.inFlight = 999;
    snap.replicas.push({ id: "ghost", url: "x", runtime: initialRuntime() });

    const fresh = reg.getSnapshot();
    expect(fresh.replicas).toHaveLength(1);
    expect(fresh.replicas[0]!.runtime.inFlight).toBe(0);
  });

  it("is empty before anything is registered", () => {
    expect(new Registry().getSnapshot().replicas).toEqual([]);
  });
});

describe("Registry.has", () => {
  it("reports whether an id is registered", () => {
    const reg = new Registry();
    reg.register(replica("replica-1"));
    expect(reg.has("replica-1")).toBe(true);
    expect(reg.has("replica-2")).toBe(false);
  });
});
