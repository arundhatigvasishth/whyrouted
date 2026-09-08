import { describe, it, expect, vi } from "vitest";
import { HealthScheduler, type HealthTransition } from "../src/health/scheduler.js";
import { Registry } from "../src/registry/registry.js";
import type { ReplicaAdapter, HealthResult } from "../src/adapter/types.js";

const OK: HealthResult = { alive: true, latencyMs: 12, inFlight: 2 };
const DOWN: HealthResult = { alive: false, latencyMs: 500, inFlight: 0 };

/** Adapter that replays a scripted sequence of results per replica id. */
class ScriptedAdapter implements ReplicaAdapter {
  private readonly cursor = new Map<string, number>();
  constructor(private readonly script: Record<string, HealthResult[]>) {}

  checkHealth(id: string): Promise<HealthResult> {
    const seq = this.script[id] ?? [];
    const i = this.cursor.get(id) ?? 0;
    this.cursor.set(id, i + 1);
    return Promise.resolve(seq[Math.min(i, seq.length - 1)] ?? DOWN);
  }

  sendRequest(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
}

function setup(
  script: Record<string, HealthResult[]>,
  overrides: Partial<{ n: number; m: number }> = {},
) {
  const registry = new Registry();
  for (const id of Object.keys(script)) {
    registry.register({ id, url: `http://127.0.0.1/${id}` });
  }
  const transitions: HealthTransition[] = [];
  const scheduler = new HealthScheduler({
    adapter: new ScriptedAdapter(script),
    sink: registry,
    replicaIds: Object.keys(script),
    intervalMs: 1000,
    unhealthyThreshold: overrides.n ?? 3,
    healthyThreshold: overrides.m ?? 2,
    onTransition: (t) => transitions.push(t),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  return { registry, scheduler, transitions };
}

const runPolls = async (s: HealthScheduler, times: number) => {
  for (let i = 0; i < times; i++) await s.pollAll();
};

const healthOf = (registry: Registry, id: string) =>
  registry.getSnapshot().replicas.find((r) => r.id === id)!.runtime.health;

describe("HealthScheduler hysteresis", () => {
  it("moves unknown → healthy after M consecutive successes", async () => {
    const { registry, scheduler, transitions } = setup({ "replica-1": [OK] }, { m: 2 });

    await scheduler.pollAll();
    expect(healthOf(registry, "replica-1")).toBe("unknown");

    await scheduler.pollAll();
    expect(healthOf(registry, "replica-1")).toBe("healthy");
    expect(transitions).toEqual([
      { replicaId: "replica-1", from: "unknown", to: "healthy", at: "2026-09-01T12:00:00.000Z" },
    ]);
  });

  it("moves healthy → unhealthy only after N consecutive failures", async () => {
    const { registry, scheduler, transitions } = setup(
      { "replica-1": [OK, OK, DOWN, DOWN, DOWN] },
      { n: 3, m: 2 },
    );

    await runPolls(scheduler, 2); // healthy
    expect(healthOf(registry, "replica-1")).toBe("healthy");

    await runPolls(scheduler, 2); // 2 failures — not yet
    expect(healthOf(registry, "replica-1")).toBe("healthy");

    await scheduler.pollAll(); // 3rd failure
    expect(healthOf(registry, "replica-1")).toBe("unhealthy");
    expect(transitions.map((t) => t.to)).toEqual(["healthy", "unhealthy"]);
  });

  it("writes latencyMs:null and inFlight:0 for a failed probe", async () => {
    const { registry, scheduler } = setup({ "replica-1": [DOWN] });

    await scheduler.pollAll();
    const runtime = registry.getSnapshot().replicas[0]!.runtime;
    expect(runtime.latencyMs).toBeNull();
    expect(runtime.inFlight).toBe(0);
    expect(runtime.consecFailures).toBe(1);
  });

  it("writes the probe latency and in-flight for a live replica", async () => {
    const { registry, scheduler } = setup({ "replica-1": [OK] });

    await scheduler.pollAll();
    const runtime = registry.getSnapshot().replicas[0]!.runtime;
    expect(runtime.latencyMs).toBe(12);
    expect(runtime.inFlight).toBe(2);
    expect(runtime.lastCheckedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("recovers unhealthy → healthy after M successes", async () => {
    const { registry, scheduler, transitions } = setup(
      { "replica-1": [DOWN, DOWN, DOWN, OK, OK] },
      { n: 3, m: 2 },
    );

    await runPolls(scheduler, 3);
    expect(healthOf(registry, "replica-1")).toBe("unhealthy");

    await scheduler.pollAll(); // 1 success
    expect(healthOf(registry, "replica-1")).toBe("unhealthy");

    await scheduler.pollAll(); // 2 successes
    expect(healthOf(registry, "replica-1")).toBe("healthy");
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "unknown->unhealthy",
      "unhealthy->healthy",
    ]);
  });

  it("does not flap on alternating pass/fail", async () => {
    const script: HealthResult[] = [];
    for (let i = 0; i < 20; i++) script.push(i % 2 === 0 ? OK : DOWN);
    const { registry, scheduler, transitions } = setup({ "replica-1": script }, { n: 3, m: 2 });

    await runPolls(scheduler, 20);
    expect(healthOf(registry, "replica-1")).toBe("unknown");
    expect(transitions).toHaveLength(0);
  });

  it("tracks each replica independently", async () => {
    const { registry, scheduler } = setup(
      { "replica-1": [OK, OK], "replica-2": [DOWN, DOWN, DOWN] },
      { n: 3, m: 2 },
    );

    await runPolls(scheduler, 3);
    expect(healthOf(registry, "replica-1")).toBe("healthy");
    expect(healthOf(registry, "replica-2")).toBe("unhealthy");
  });
});

describe("HealthScheduler.eject", () => {
  it("marks the replica unhealthy immediately and emits a transition carrying the reason", () => {
    const { registry, scheduler, transitions } = setup({ "replica-1": [OK] });

    scheduler.eject("replica-1", "request failure");
    expect(healthOf(registry, "replica-1")).toBe("unhealthy");
    expect(transitions).toEqual([
      {
        replicaId: "replica-1",
        from: "unknown",
        to: "unhealthy",
        at: "2026-09-01T12:00:00.000Z",
        reason: "request failure",
      },
    ]);
  });

  it("syncs the snapshot's consec counters with the eject, not the last poll", async () => {
    const { registry, scheduler } = setup({ "replica-1": [OK, OK] }, { n: 3, m: 2 });

    await runPolls(scheduler, 2); // healthy, consecSuccesses now 2
    scheduler.eject("replica-1", "request failure");

    const runtime = registry.getSnapshot().replicas.find((r) => r.id === "replica-1")!.runtime;
    expect(runtime.health).toBe("unhealthy");
    expect(runtime.consecSuccesses).toBe(0);
    expect(runtime.consecFailures).toBe(3);
  });

  it("does not recover before M consecutive clean probes after an eject", async () => {
    const { registry, scheduler } = setup({ "replica-1": [OK, OK] }, { m: 2 });

    scheduler.eject("replica-1", "request failure");
    await scheduler.pollAll(); // 1 clean probe
    expect(healthOf(registry, "replica-1")).toBe("unhealthy");

    await scheduler.pollAll(); // 2nd clean probe — recovers
    expect(healthOf(registry, "replica-1")).toBe("healthy");
  });

  it("a real recovery after eject still emits unhealthy -> healthy", async () => {
    const { scheduler, transitions } = setup({ "replica-1": [OK, OK] }, { m: 2 });

    scheduler.eject("replica-1", "request failure");
    await runPolls(scheduler, 2);

    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "unknown->unhealthy",
      "unhealthy->healthy",
    ]);
  });

  it("is a no-op transition (but still safe) when already unhealthy", () => {
    const { registry, scheduler, transitions } = setup({ "replica-1": [DOWN] }, { n: 3 });

    scheduler.eject("replica-1", "first eject");
    scheduler.eject("replica-1", "second eject");

    expect(healthOf(registry, "replica-1")).toBe("unhealthy");
    expect(transitions).toHaveLength(1);
  });

  it("does not erase in-progress recovery when ejected a second time", async () => {
    // Regression: a stale/duplicate eject (e.g. a request that failed after
    // an earlier failure already ejected the same replica) must not reset
    // consecSuccesses a real health probe already earned toward recovery.
    const { registry, scheduler, transitions } = setup({ "replica-1": [OK, OK] }, { m: 2 });

    scheduler.eject("replica-1", "first failure");
    await scheduler.pollAll(); // 1 clean probe: consecSuccesses = 1, still unhealthy

    const midway = registry.getSnapshot().replicas[0]!.runtime;
    expect(midway.consecSuccesses).toBe(1);
    expect(midway.health).toBe("unhealthy");

    scheduler.eject("replica-1", "stale request failure"); // should be a true no-op now

    const afterSecondEject = registry.getSnapshot().replicas[0]!.runtime;
    expect(afterSecondEject.consecSuccesses).toBe(1); // NOT reset to 0
    expect(transitions).toHaveLength(1); // no second transition emitted

    await scheduler.pollAll(); // the 2nd clean probe should now recover it
    expect(healthOf(registry, "replica-1")).toBe("healthy");
  });

  it("throws on an unregistered replica id", () => {
    const { scheduler } = setup({ "replica-1": [OK] });
    expect(() => scheduler.eject("replica-9", "request failure")).toThrow(/unknown replica/);
  });
});

describe("HealthScheduler start/stop", () => {
  it("polls immediately on start and then on the interval", async () => {
    vi.useFakeTimers();
    try {
      const { registry, scheduler } = setup({ "replica-1": [OK] }, { m: 2 });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0); // immediate sweep
      expect(healthOf(registry, "replica-1")).toBe("unknown");

      await vi.advanceTimersByTimeAsync(1000); // second sweep
      expect(healthOf(registry, "replica-1")).toBe("healthy");

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      // no throw, no further work — snapshot unchanged
      expect(healthOf(registry, "replica-1")).toBe("healthy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("start is idempotent", () => {
    const { scheduler } = setup({ "replica-1": [OK] });
    scheduler.start();
    scheduler.start();
    scheduler.stop();
  });
});
