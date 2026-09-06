/**
 * Synthetic load / latency generator for a simulated replica.
 *
 * Gives each replica a life of its own: a latency band it samples per request,
 * and a slow baseline-load wave so the fleet's `inFlight` numbers drift the way
 * a real serving fleet's would. The fleet launcher gives each replica a
 * different profile so load distribution is visible once routing lands.
 *
 * Deterministic when given a fixed clock and rng — that's what the tests use.
 */

export interface SyntheticProfile {
  /** Centre of the latency band, in ms. */
  baseLatencyMs: number;
  /** Uniform +/- jitter added to every latency sample, in ms. */
  latencyJitterMs: number;
  /** Peak baseline in-flight the slow wave adds on top of real load. */
  loadAmplitude: number;
  /** Period of the baseline-load wave, in ms. */
  periodMs: number;
}

export const DEFAULT_PROFILE: SyntheticProfile = {
  baseLatencyMs: 15,
  latencyJitterMs: 10,
  loadAmplitude: 3,
  periodMs: 20_000,
};

/**
 * Deterministic, distinct profile for the Nth replica (0-based) in a fleet, so
 * routing strategies have real load/latency spread to distribute across instead
 * of every replica behaving identically. Latency and amplitude both scale with
 * index; wraps every 4 replicas so an arbitrarily large fleet still gets a mix.
 */
export function profileForIndex(index: number): SyntheticProfile {
  const band = index % 4;
  return {
    baseLatencyMs: DEFAULT_PROFILE.baseLatencyMs + band * 10,
    latencyJitterMs: DEFAULT_PROFILE.latencyJitterMs,
    loadAmplitude: DEFAULT_PROFILE.loadAmplitude + band * 2,
    periodMs: DEFAULT_PROFILE.periodMs,
  };
}

export interface Synthetic {
  /** A latency sample for one `/infer` call, in ms (always >= 1). */
  latencyMs(): number;
  /** Synthetic baseline in-flight right now (integer >= 0), added to real load. */
  baselineLoad(): number;
}

/**
 * Build a generator from a profile. `now` and `rng` are injectable so tests can
 * pin the output; both default to wall-clock / `Math.random`.
 */
export function createSynthetic(
  profile: SyntheticProfile = DEFAULT_PROFILE,
  now: () => number = () => Date.now(),
  rng: () => number = Math.random,
): Synthetic {
  const startedAt = now();

  return {
    latencyMs() {
      const jitter = (rng() * 2 - 1) * profile.latencyJitterMs;
      return Math.max(1, profile.baseLatencyMs + jitter);
    },

    baselineLoad() {
      if (profile.loadAmplitude <= 0) return 0;
      const phase = (now() - startedAt) / profile.periodMs;
      const wave = (Math.sin(2 * Math.PI * phase) + 1) / 2; // 0..1
      return Math.round(wave * profile.loadAmplitude);
    },
  };
}
