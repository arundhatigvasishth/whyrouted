import { describe, it, expect } from "vitest";
import type { ReplicaState, ReplicaHealth, RegistrySnapshot } from "../src/types.js";
import type { RoutingConfig, ScoringWeights, StrategyName } from "../src/routing/types.js";
import { DEFAULT_SCORING_WEIGHTS } from "../src/routing/types.js";
import { createRoutingEngine } from "../src/routing/engine.js";

function replica(
  id: string,
  health: ReplicaHealth,
  inFlight = 0,
  latencyMs: number | null = 10,
): ReplicaState {
  return {
    id,
    url: `http://127.0.0.1:${8000 + Number(id.split("-")[1])}`,
    runtime: {
      health,
      inFlight,
      latencyMs,
      consecFailures: 0,
      consecSuccesses: 1,
      lastCheckedAt: "2026-09-06T00:00:00.000Z",
    },
  };
}

/** A registry stub whose snapshot the test controls between calls. */
function fakeRegistry(replicas: ReplicaState[]): {
  getSnapshot(): RegistrySnapshot;
  set(next: ReplicaState[]): void;
} {
  let current = replicas;
  return {
    getSnapshot: () => ({ generatedAt: "2026-09-06T00:00:00.000Z", replicas: current }),
    set: (next) => {
      current = next;
    },
  };
}

/** A mutable config holder, same surface as K10 will implement. */
function fakeConfig(
  name: StrategyName = "round-robin",
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): RoutingConfig {
  let currentName = name;
  let currentWeights = weights;
  return {
    getStrategyName: () => currentName,
    setStrategyName: (n) => {
      currentName = n;
    },
    getWeights: () => currentWeights,
    setWeights: (w) => {
      currentWeights = w;
    },
  };
}

describe("routing engine", () => {
  it("reports no_healthy_replicas when the registry is empty", () => {
    const engine = createRoutingEngine({ registry: fakeRegistry([]), config: fakeConfig() });
    expect(engine.route()).toEqual({ ok: false, error: "no_healthy_replicas" });
  });

  it("reports no_healthy_replicas when every replica is unhealthy or unknown", () => {
    const engine = createRoutingEngine({
      registry: fakeRegistry([replica("replica-1", "unhealthy"), replica("replica-2", "unknown")]),
      config: fakeConfig(),
    });
    expect(engine.route()).toEqual({ ok: false, error: "no_healthy_replicas" });
  });

  it("routes to a healthy replica and reports which strategy chose it", () => {
    const engine = createRoutingEngine({
      registry: fakeRegistry([replica("replica-1", "healthy")]),
      config: fakeConfig("least-loaded"),
    });
    expect(engine.route()).toEqual({ ok: true, replicaId: "replica-1", strategy: "least-loaded" });
  });

  it("hands the strategy only the healthy replicas", () => {
    const engine = createRoutingEngine({
      registry: fakeRegistry([
        replica("replica-1", "unhealthy", 0),
        replica("replica-2", "healthy", 5),
        replica("replica-3", "healthy", 2),
      ]),
      config: fakeConfig("least-loaded"),
    });
    // replica-1 has the lowest inFlight but is unhealthy, so it must not win.
    expect(engine.route()).toEqual({ ok: true, replicaId: "replica-3", strategy: "least-loaded" });
  });

  it("delegates to the round-robin strategy in registration order", () => {
    const engine = createRoutingEngine({
      registry: fakeRegistry([replica("replica-1", "healthy"), replica("replica-2", "healthy")]),
      config: fakeConfig("round-robin"),
    });
    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });
    expect(engine.route()).toMatchObject({ replicaId: "replica-2" });
    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });
  });

  it("reads a fresh snapshot on every call, so a health transition takes effect immediately", () => {
    const registry = fakeRegistry([
      replica("replica-1", "healthy"),
      replica("replica-2", "healthy"),
    ]);
    const engine = createRoutingEngine({ registry, config: fakeConfig("least-loaded") });

    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });

    registry.set([replica("replica-1", "unhealthy"), replica("replica-2", "healthy")]);
    expect(engine.route()).toMatchObject({ replicaId: "replica-2" });
  });

  it("keeps one strategy instance across calls, so round-robin's cursor is not reset", () => {
    const registry = fakeRegistry([
      replica("replica-1", "healthy"),
      replica("replica-2", "healthy"),
      replica("replica-3", "healthy"),
    ]);
    const engine = createRoutingEngine({ registry, config: fakeConfig("round-robin") });

    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });
    expect(engine.route()).toMatchObject({ replicaId: "replica-2" });
    expect(engine.route()).toMatchObject({ replicaId: "replica-3" });
    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });
  });

  it("rebuilds the strategy when the configured name changes", () => {
    const registry = fakeRegistry([
      replica("replica-1", "healthy", 9),
      replica("replica-2", "healthy", 1),
    ]);
    const config = fakeConfig("round-robin");
    const engine = createRoutingEngine({ registry, config });

    expect(engine.route()).toMatchObject({ replicaId: "replica-1", strategy: "round-robin" });

    config.setStrategyName("least-loaded");
    expect(engine.route()).toEqual({ ok: true, replicaId: "replica-2", strategy: "least-loaded" });
  });

  it("reads scoring weights fresh on every call", () => {
    const registry = fakeRegistry([
      replica("replica-1", "healthy", 0, 100),
      replica("replica-2", "healthy", 10, 10),
    ]);
    const config = fakeConfig("latency-weighted", { loadWeight: 1, latencyWeight: 1 });
    const engine = createRoutingEngine({ registry, config });

    // 1*0 + 1*100 = 100 vs 1*10 + 1*10 = 20 -> replica-2
    expect(engine.route()).toMatchObject({ replicaId: "replica-2" });

    // drop the latency term: 0 vs 10 -> replica-1
    config.setWeights({ loadWeight: 1, latencyWeight: 0 });
    expect(engine.route()).toMatchObject({ replicaId: "replica-1" });
  });

  it("reports no_routable_replica when healthy replicas exist but the strategy picks none", () => {
    const engine = createRoutingEngine({
      registry: fakeRegistry([
        replica("replica-1", "healthy", 0, null),
        replica("replica-2", "healthy", 0, null),
      ]),
      config: fakeConfig("latency-weighted"),
    });
    expect(engine.route()).toEqual({ ok: false, error: "no_routable_replica" });
  });
});
