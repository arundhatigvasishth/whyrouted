import { describe, it, expect } from "vitest";
import {
  createSynthetic,
  DEFAULT_PROFILE,
  type SyntheticProfile,
} from "../src/replica/synthetic.js";

const profile: SyntheticProfile = {
  baseLatencyMs: 20,
  latencyJitterMs: 8,
  loadAmplitude: 6,
  periodMs: 10_000,
};

describe("createSynthetic.latencyMs", () => {
  it("stays within the base +/- jitter band", () => {
    let rng = 0;
    const rngValues = [0, 0.5, 1, 0.25, 0.75];
    const synthetic = createSynthetic(
      profile,
      () => 0,
      () => rngValues[rng++ % rngValues.length]!,
    );

    for (let i = 0; i < 20; i++) {
      const ms = synthetic.latencyMs();
      expect(ms).toBeGreaterThanOrEqual(profile.baseLatencyMs - profile.latencyJitterMs);
      expect(ms).toBeLessThanOrEqual(profile.baseLatencyMs + profile.latencyJitterMs);
    }
  });

  it("never returns less than 1 ms even with a tiny base", () => {
    const synthetic = createSynthetic(
      { ...profile, baseLatencyMs: 2, latencyJitterMs: 10 },
      () => 0,
      () => 0, // rng 0 => jitter = -latencyJitterMs
    );
    expect(synthetic.latencyMs()).toBe(1);
  });

  it("is deterministic for a fixed rng", () => {
    const make = () =>
      createSynthetic(
        profile,
        () => 0,
        () => 0.3,
      );
    expect(make().latencyMs()).toBe(make().latencyMs());
  });
});

describe("createSynthetic.baselineLoad", () => {
  it("is 0 when the amplitude is 0", () => {
    let t = 0;
    const synthetic = createSynthetic({ ...profile, loadAmplitude: 0 }, () => (t += 1000));
    for (let i = 0; i < 10; i++) expect(synthetic.baselineLoad()).toBe(0);
  });

  it("stays within [0, amplitude] as time advances", () => {
    let t = 0;
    const synthetic = createSynthetic(profile, () => (t += 137));
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const load = synthetic.baselineLoad();
      expect(load).toBeGreaterThanOrEqual(0);
      expect(load).toBeLessThanOrEqual(profile.loadAmplitude);
      seen.add(load);
    }
    // the wave should actually move, not sit on one value
    expect(seen.size).toBeGreaterThan(1);
  });

  it("returns whole numbers", () => {
    let t = 0;
    const synthetic = createSynthetic(profile, () => (t += 250));
    for (let i = 0; i < 20; i++) expect(Number.isInteger(synthetic.baselineLoad())).toBe(true);
  });
});

describe("DEFAULT_PROFILE", () => {
  it("is a usable profile", () => {
    const synthetic = createSynthetic(DEFAULT_PROFILE);
    expect(synthetic.latencyMs()).toBeGreaterThan(0);
    expect(synthetic.baselineLoad()).toBeGreaterThanOrEqual(0);
  });
});
