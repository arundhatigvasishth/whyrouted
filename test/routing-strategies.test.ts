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
  it("cycles through candidates in the order given (registration order, per the engine)", () => {
    const strategy = createRoundRobin();
    const candidates = [candidate("replica-1", 0, 10), candidate("replica-2", 0, 10)];

    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-2");
    expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
  });

  it("does not re-sort candidates itself", () => {
    const strategy = createRoundRobin();
    const candidates = [candidate("replica-2", 0, 10), candidate("replica-1", 0, 10)];

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

  describe("score()", () => {
    it("scores the next candidate to be picked 0, wrapping upward from the cursor", () => {
      const strategy = createRoundRobin();
      const candidates = [
        candidate("replica-1", 0, 10),
        candidate("replica-2", 0, 10),
        candidate("replica-3", 0, 10),
      ];
      strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS); // advance cursor onto replica-2

      const scores = strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
      expect(scores.map((s) => s.score)).toEqual([2, 0, 1]);
    });

    it("does not advance the cursor", () => {
      const strategy = createRoundRobin();
      const candidates = [candidate("replica-1", 0, 10), candidate("replica-2", 0, 10)];

      strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
      strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
      expect(strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS)).toBe("replica-1");
    });

    it("returns [] with no candidates", () => {
      expect(createRoundRobin().score([], DEFAULT_SCORING_WEIGHTS)).toEqual([]);
    });

    it("carries each candidate's real inFlight and latencyMs, not just the stand-in score", () => {
      const strategy = createRoundRobin();
      const candidates = [candidate("replica-1", 3, 42), candidate("replica-2", 0, null)];
      const scores = strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
      expect(scores).toEqual([
        { replicaId: "replica-1", inFlight: 3, latencyMs: 42, score: 0, considered: true },
        { replicaId: "replica-2", inFlight: 0, latencyMs: null, score: 1, considered: true },
      ]);
    });
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

  describe("score()", () => {
    it("scores every candidate by in-flight count", () => {
      const strategy = createLeastLoaded();
      const candidates = [candidate("replica-1", 5, 10), candidate("replica-2", 2, 10)];
      expect(strategy.score(candidates, DEFAULT_SCORING_WEIGHTS)).toEqual([
        { replicaId: "replica-1", inFlight: 5, latencyMs: 10, score: 5, considered: true },
        { replicaId: "replica-2", inFlight: 2, latencyMs: 10, score: 2, considered: true },
      ]);
    });

    it("scores every candidate it's handed, never dropping one", () => {
      const strategy = createLeastLoaded();
      const candidates = [
        candidate("replica-1", 0, null),
        candidate("replica-2", 1, 5),
        candidate("replica-3", 2, 5),
      ];
      expect(strategy.score(candidates, DEFAULT_SCORING_WEIGHTS)).toHaveLength(3);
    });

    it("returns [] with no candidates", () => {
      expect(createLeastLoaded().score([], DEFAULT_SCORING_WEIGHTS)).toEqual([]);
    });
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

  describe("score()", () => {
    it("reflects the given weights in the score", () => {
      const strategy = createLatencyWeighted();
      const candidates = [candidate("replica-1", 5, 999)];
      const [scored] = strategy.score(candidates, { loadWeight: 10, latencyWeight: 0 });
      expect(scored?.score).toBe(50);
    });

    it("omits a candidate with no latency measurement, same as pick()", () => {
      const strategy = createLatencyWeighted();
      const candidates = [candidate("replica-1", 0, null), candidate("replica-2", 5, 10)];
      const scores = strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
      expect(scores.map((s) => s.replicaId)).toEqual(["replica-2"]);
    });

    it("returns [] when every candidate lacks a latency measurement", () => {
      const strategy = createLatencyWeighted();
      const candidates = [candidate("replica-1", 0, null), candidate("replica-2", 0, null)];
      expect(strategy.score(candidates, DEFAULT_SCORING_WEIGHTS)).toEqual([]);
    });

    it("returns [] with no candidates", () => {
      expect(createLatencyWeighted().score([], DEFAULT_SCORING_WEIGHTS)).toEqual([]);
    });
  });
});

describe("score()/pick() consistency (N7)", () => {
  // For every strategy, the candidate score() ranks lowest must always be
  // the same replica pick() actually returns, for the same candidate set
  // and weights. Guards against the two methods silently drifting apart,
  // e.g. a scoring-formula change made in one but not the other.
  const cases: Array<{ name: string; make: () => ReturnType<typeof createRoundRobin> }> = [
    { name: "round-robin", make: createRoundRobin },
    { name: "least-loaded", make: createLeastLoaded },
    { name: "latency-weighted", make: createLatencyWeighted },
  ];

  const candidateSets: ReplicaState[][] = [
    [candidate("replica-1", 0, 10), candidate("replica-2", 0, 10), candidate("replica-3", 0, 10)],
    [candidate("replica-1", 5, 100), candidate("replica-2", 2, 5), candidate("replica-3", 8, 50)],
    [candidate("replica-1", 3, 10), candidate("replica-2", 3, 10)], // tie
    [candidate("replica-1", 0, null), candidate("replica-2", 4, 20)],
    [candidate("replica-1", 1, 1)],
  ];

  for (const { name, make } of cases) {
    it(`${name}: score()'s lowest-scoring candidate matches pick()'s winner`, () => {
      for (const candidates of candidateSets) {
        // Fresh instance per set: round-robin's cursor must not leak
        // between independent candidate sets in this check.
        const strategy = make();
        const scores = strategy.score(candidates, DEFAULT_SCORING_WEIGHTS);
        const picked = strategy.pick(candidates, DEFAULT_SCORING_WEIGHTS);

        if (scores.length === 0) {
          expect(picked).toBeNull();
          continue;
        }

        const bestScore = Math.min(...scores.map((s) => s.score));
        const winners = scores.filter((s) => s.score === bestScore).map((s) => s.replicaId);
        const tieBreakWinner = winners.sort()[0];
        expect(picked).toBe(tieBreakWinner);
      }
    });
  }
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
