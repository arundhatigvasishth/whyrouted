import { describe, it, expect } from "vitest";
import { createRoutingConfig, assertValidWeights } from "../src/routing/config.js";

describe("createRoutingConfig", () => {
  const init = { strategy: "round-robin" as const, weights: { loadWeight: 1, latencyWeight: 1 } };

  it("returns the startup strategy and weights", () => {
    const config = createRoutingConfig(init);
    expect(config.getStrategyName()).toBe("round-robin");
    expect(config.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });

  it("swaps the strategy live", () => {
    const config = createRoutingConfig(init);
    config.setStrategyName("latency-weighted");
    expect(config.getStrategyName()).toBe("latency-weighted");
  });

  it("tunes the weights live", () => {
    const config = createRoutingConfig(init);
    config.setWeights({ loadWeight: 0.2, latencyWeight: 0.8 });
    expect(config.getWeights()).toEqual({ loadWeight: 0.2, latencyWeight: 0.8 });
  });

  it("rejects an unknown strategy name at construction", () => {
    // @ts-expect-error deliberately invalid
    expect(() => createRoutingConfig({ ...init, strategy: "fastest" })).toThrow(
      /unknown routing strategy/,
    );
  });

  it("rejects an unknown strategy name from the setter", () => {
    const config = createRoutingConfig(init);
    // @ts-expect-error deliberately invalid
    expect(() => config.setStrategyName("fastest")).toThrow(/unknown routing strategy/);
    expect(config.getStrategyName()).toBe("round-robin");
  });

  it("rejects negative or non-finite weights from the setter", () => {
    const config = createRoutingConfig(init);
    expect(() => config.setWeights({ loadWeight: -1, latencyWeight: 1 })).toThrow(/loadWeight/);
    expect(() => config.setWeights({ loadWeight: 1, latencyWeight: NaN })).toThrow(/latencyWeight/);
    expect(() => config.setWeights({ loadWeight: Infinity, latencyWeight: 1 })).toThrow(
      /loadWeight/,
    );
    expect(config.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });

  it("does not let a caller mutate internal state through a returned weights object", () => {
    const config = createRoutingConfig(init);
    const weights = config.getWeights();
    weights.loadWeight = 999;
    expect(config.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });

  it("does not alias the init weights object", () => {
    const weights = { loadWeight: 1, latencyWeight: 1 };
    const config = createRoutingConfig({ strategy: "round-robin", weights });
    weights.loadWeight = 999;
    expect(config.getWeights()).toEqual({ loadWeight: 1, latencyWeight: 1 });
  });
});

describe("assertValidWeights", () => {
  it("accepts finite non-negative weights", () => {
    expect(() => assertValidWeights({ loadWeight: 0, latencyWeight: 2.5 })).not.toThrow();
  });

  it("rejects a negative weight", () => {
    expect(() => assertValidWeights({ loadWeight: 0, latencyWeight: -0.1 })).toThrow(
      /latencyWeight/,
    );
  });
});
