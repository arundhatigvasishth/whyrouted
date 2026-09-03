/**
 * Config loader (B5).
 *
 * Reads the whole `Config` from environment variables (all prefixed `WR_`),
 * fills in defaults, and validates. `main.ts` (J3) calls `loadConfig()` once at
 * startup and passes narrow slices down — no other module imports `Config`.
 *
 * Shape and defaults are fixed by docs/milestones/m1/shared-contract.md.
 */

import type { Replica } from "./types.js";

export interface Config {
  /** Host the replicas and the status server bind to. */
  host: string;
  /** Number of simulated replicas. */
  fleetSize: number;
  /** First replica port; the fleet occupies `basePort .. basePort + fleetSize - 1`. */
  basePort: number;
  /** Port `GET /status` listens on. */
  statusPort: number;
  /** How often the health scheduler polls each replica, in ms. */
  healthIntervalMs: number;
  /** Per-probe timeout, in ms. Must be `< healthIntervalMs`. */
  healthTimeoutMs: number;
  /** N — consecutive failed probes before a replica is marked `unhealthy`. */
  unhealthyThreshold: number;
  /** M — consecutive successful probes before a replica recovers to `healthy`. */
  healthyThreshold: number;
}

export const DEFAULT_CONFIG: Config = {
  host: "127.0.0.1",
  fleetSize: 4,
  basePort: 8001,
  statusPort: 8080,
  healthIntervalMs: 1000,
  healthTimeoutMs: 500,
  unhealthyThreshold: 3,
  healthyThreshold: 2,
};

type Env = Record<string, string | undefined>;

function readInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Build the config from `env` (defaults to `process.env`), applying defaults and
 * validating. Throws with a combined message listing every problem if the
 * result is not usable.
 */
export function loadConfig(env: Env = process.env): Config {
  const config: Config = {
    host: env.WR_HOST?.trim() || DEFAULT_CONFIG.host,
    fleetSize: readInt(env, "WR_FLEET_SIZE", DEFAULT_CONFIG.fleetSize),
    basePort: readInt(env, "WR_BASE_PORT", DEFAULT_CONFIG.basePort),
    statusPort: readInt(env, "WR_STATUS_PORT", DEFAULT_CONFIG.statusPort),
    healthIntervalMs: readInt(env, "WR_HEALTH_INTERVAL_MS", DEFAULT_CONFIG.healthIntervalMs),
    healthTimeoutMs: readInt(env, "WR_HEALTH_TIMEOUT_MS", DEFAULT_CONFIG.healthTimeoutMs),
    unhealthyThreshold: readInt(env, "WR_UNHEALTHY_THRESHOLD", DEFAULT_CONFIG.unhealthyThreshold),
    healthyThreshold: readInt(env, "WR_HEALTHY_THRESHOLD", DEFAULT_CONFIG.healthyThreshold),
  };
  validate(config);
  return config;
}

function validate(c: Config): void {
  const errors: string[] = [];

  if (c.fleetSize < 1) errors.push("WR_FLEET_SIZE must be >= 1");

  for (const [name, port] of [
    ["WR_BASE_PORT", c.basePort],
    ["WR_STATUS_PORT", c.statusPort],
  ] as const) {
    if (port < 1 || port > 65535) errors.push(`${name} must be between 1 and 65535`);
  }

  const topPort = c.basePort + Math.max(c.fleetSize, 1) - 1;
  if (topPort > 65535) {
    errors.push(`WR_BASE_PORT + WR_FLEET_SIZE - 1 = ${topPort} exceeds 65535`);
  }
  if (c.statusPort >= c.basePort && c.statusPort <= topPort) {
    errors.push(
      `WR_STATUS_PORT ${c.statusPort} collides with the replica port range ${c.basePort}-${topPort}`,
    );
  }

  if (c.healthIntervalMs < 1) errors.push("WR_HEALTH_INTERVAL_MS must be >= 1");
  if (c.healthTimeoutMs < 1) errors.push("WR_HEALTH_TIMEOUT_MS must be >= 1");
  if (c.healthTimeoutMs >= c.healthIntervalMs) {
    errors.push(
      `WR_HEALTH_TIMEOUT_MS (${c.healthTimeoutMs}) must be < WR_HEALTH_INTERVAL_MS (${c.healthIntervalMs})`,
    );
  }

  if (c.unhealthyThreshold < 1) errors.push("WR_UNHEALTHY_THRESHOLD must be >= 1");
  if (c.healthyThreshold < 1) errors.push("WR_HEALTHY_THRESHOLD must be >= 1");

  if (errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Derive the fleet's replica list from config. Ids are 1-based
 * (`replica-1 .. replica-N`); each url is `http://{host}:{basePort + index}`.
 */
export function fleetReplicas(c: Config): Replica[] {
  return Array.from({ length: c.fleetSize }, (_, i) => ({
    id: `replica-${i + 1}`,
    url: `http://${c.host}:${c.basePort + i}`,
  }));
}
