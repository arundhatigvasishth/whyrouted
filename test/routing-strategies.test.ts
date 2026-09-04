import { describe, it, expect } from "vitest";
import type { ReplicaState } from "../src/types.js";
import { createRoundRobin } from "../src/routing/strategies/round-robin.js";
import { createLeastLoaded } from "../src/routing/strategies/least-loaded.js";
import { createLatencyWeighted } from "../src/routing/strategies/latency-weighted.js";
import { createStrategy, STRATEGY_NAMES } from "../src/routing/strategies/index.js";
import { DEFAULT_SCORING_WEIGHTS } from "../src/routing/types.js";

function candidate(id: string, inFlight: number, latencyMs: number | null): ReplicaState {
  return {
    id,
    url: `http://127.0.0.1:${8000 + Number(id.split("-")[1])}`,
    runtime: {
      health: "healthy",
      inFlight,
      latencyMs,
      consecFailures: 0,
      consecSuccesses: 1,
      lastCheckedAt: "2026-09-04T00:00:00.000Z",
    },
  };
}

describe("round-robin", () => {
  it("cycles through candidates in id order", () => {
    const strategy = createRoundRobin();
    const candidates = [candidate("replica-2", 0, 10), candidate("replica-1", 0, 10)];

    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-2");
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
  });

  it("returns null with no candidates", () => {
    expect(createRoundRobin().pick([], DEFAULT_SCORING_WEIGHTS)).toBeNull();
  });

  it("still picks something sensible with a single candidate", () => {
    const strategy = createRoundRobin();
    const candidates = [candidate("replica-1", 0, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
  });
});

describe("least-loaded", () => {
  it("picks the candidate with the lowest in-flight count", () => {
    const strategy = createLeastLoaded();
    const candidates = [candidate("replica-1", 5, 10), candidate("replica-2", 2, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-2");
  });

  it("breaks ties by replica id", () => {
    const strategy = createLeastLoaded();
    const candidates = [candidate("replica-2", 3, 10), candidate("replica-1", 3, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
  });

  it("returns null with no candidates", () => {
    expect(createLeastLoaded().pick([], DEFAULT_SCORING_WEIGHTS)).toBeNull();
  });

  it("picks the only candidate when there's just one", () => {
    const strategy = createLeastLoaded();
    expect(strategy.pick([candidate("replica-1", 9, 10)], DEFAULT_SCORING_WEIGHTS)).toBe(
      "replica-1",
    );
  });
});

describe("latency-weighted", () => {
  it("picks the lowest weighted score", () => {
    const strategy = createLatencyWeighted();
    const candidates = [candidate("replica-1", 0, 100), candidate("replica-2", 0, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-2");
  });

  it("weighs load and latency according to the given weights", () => {
    const strategy = createLatencyWeighted();
    // replica-1: 10*load + 0*latency = 10*5 = 50; replica-2: 10*1 = 10
    const candidates = [candidate("replica-1", 5, 999), candidate("replica-2", 1, 999)];
    expect(strategy.pick(candidates, { loadWeight: 10, latencyWeight: 0 })).toBe("replica-2");
  });

  it("excludes candidates with no latency measurement yet", () => {
    const strategy = createLatencyWeighted();
    const candidates = [candidate("replica-1", 0, null), candidate("replica-2", 5, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-2");
  });

  it("returns null when every candidate lacks a latency measurement", () => {
    const strategy = createLatencyWeighted();
    const candidates = [candidate("replica-1", 0, null), candidate("replica-2", 0, null)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBeNull();
  });

  it("returns null with no candidates", () => {
    expect(createLatencyWeighted().pick([], DEFAULT_SCORING_WEIGHTS)).toBeNull();
  });

  it("breaks ties by replica id", () => {
    const strategy = createLatencyWeighted();
    const candidates = [candidate("replica-2", 0, 10), candidate("replica-1", 0, 10)];
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
  });
});

describe("strategy registry", () => {
  it("builds every named strategy", () => {
    for (const name of STRATEGY_NAMES) {
      expect(createStrategy(name).name).toBe(name);
    }
  });

  it("throws on an unknown strategy name", () => {
    // @ts-expect-error deliberately passing an invalid name
    expect(() => createStrategy("fastest")).toThrow(/unknown routing strategy/);
  });
});
