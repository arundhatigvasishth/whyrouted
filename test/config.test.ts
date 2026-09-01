import { describe, it, expect } from "vitest";
import { loadConfig, fleetReplicas, DEFAULT_CONFIG } from "../src/config.js";

describe("loadConfig", () => {
  it("returns the documented defaults for an empty env", () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("overrides individual values from WR_ env vars", () => {
    const config = loadConfig({
      WR_HOST: "0.0.0.0",
      WR_FLEET_SIZE: "2",
      WR_BASE_PORT: "9001",
      WR_STATUS_PORT: "9999",
      WR_HEALTH_INTERVAL_MS: "2000",
      WR_HEALTH_TIMEOUT_MS: "750",
      WR_UNHEALTHY_THRESHOLD: "5",
      WR_HEALTHY_THRESHOLD: "1",
    });
    expect(config).toEqual({
      host: "0.0.0.0",
      fleetSize: 2,
      basePort: 9001,
      statusPort: 9999,
      healthIntervalMs: 2000,
      healthTimeoutMs: 750,
      unhealthyThreshold: 5,
      healthyThreshold: 1,
    });
  });

  it("treats an empty-string env var as unset", () => {
    expect(loadConfig({ WR_HOST: "  ", WR_FLEET_SIZE: "" })).toEqual(DEFAULT_CONFIG);
  });

  it("rejects a non-integer numeric var", () => {
    expect(() => loadConfig({ WR_FLEET_SIZE: "four" })).toThrow(/WR_FLEET_SIZE must be an integer/);
    expect(() => loadConfig({ WR_BASE_PORT: "80.5" })).toThrow(/WR_BASE_PORT must be an integer/);
  });

  it("rejects a fleet size below 1", () => {
    expect(() => loadConfig({ WR_FLEET_SIZE: "0" })).toThrow(/WR_FLEET_SIZE must be >= 1/);
  });

  it("rejects a health timeout that is not less than the interval", () => {
    expect(() =>
      loadConfig({ WR_HEALTH_TIMEOUT_MS: "1000", WR_HEALTH_INTERVAL_MS: "1000" }),
    ).toThrow(/must be < WR_HEALTH_INTERVAL_MS/);
  });

  it("rejects a status port that falls inside the replica range", () => {
    expect(() =>
      loadConfig({ WR_BASE_PORT: "8001", WR_FLEET_SIZE: "4", WR_STATUS_PORT: "8003" }),
    ).toThrow(/collides with the replica port range 8001-8004/);
  });

  it("rejects a port outside 1..65535", () => {
    expect(() => loadConfig({ WR_STATUS_PORT: "70000" })).toThrow(/between 1 and 65535/);
  });

  it("reports every problem at once", () => {
    expect(() => loadConfig({ WR_FLEET_SIZE: "0", WR_HEALTHY_THRESHOLD: "0" })).toThrow(
      /WR_FLEET_SIZE must be >= 1[\s\S]*WR_HEALTHY_THRESHOLD must be >= 1/,
    );
  });
});

describe("fleetReplicas", () => {
  it("derives 1-based ids and consecutive ports from config", () => {
    expect(fleetReplicas(loadConfig({}))).toEqual([
      { id: "replica-1", url: "http://127.0.0.1:8001" },
      { id: "replica-2", url: "http://127.0.0.1:8002" },
      { id: "replica-3", url: "http://127.0.0.1:8003" },
      { id: "replica-4", url: "http://127.0.0.1:8004" },
    ]);
  });

  it("honours a custom host and base port", () => {
    const replicas = fleetReplicas(
      loadConfig({ WR_HOST: "10.0.0.5", WR_BASE_PORT: "5000", WR_FLEET_SIZE: "1" }),
    );
    expect(replicas).toEqual([{ id: "replica-1", url: "http://10.0.0.5:5000" }]);
  });
});
