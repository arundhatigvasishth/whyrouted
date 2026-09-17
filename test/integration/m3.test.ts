/**
 * M3 integration test (L17, pair task).
 *
 * Builds the whole system the way `main.ts` wires it, real replica child
 * processes through `launchFleet`, a real `HttpReplicaAdapter` over HTTP, the
 * real `HealthScheduler`, engine, and API server, but in-process instead of
 * through a `main.ts` child process. That gives the test a live reference to
 * the `FailoverLog` instance, which `POST /route` and the scheduler both
 * write to, so it can assert on recorded events directly.
 *
 * Resolved (was an open question in the draft): stays in-process rather than
 * spawning `main.ts`, since M5a's `get_failover_history` HTTP surface doesn't
 * exist yet. Building a test-only route just to expose the log for one
 * milestone would be more to maintain than the in-process build, and this
 * test still exercises the real HTTP boundary between the client and
 * `/route` (the part M1/M2's spawn-based tests are actually protecting) via
 * real `fetch` calls. Revisit once M5a's real HTTP surface exists: at that
 * point the spawn-based pattern becomes free again and this could switch.
 *
 * Drives continuous `POST /route` load, kills one replica mid-stream, and
 * asserts the M3 definition of done (docs/milestones/m3/task-split.md §9):
 * zero lost requests, sub-1s detection via request-driven ejection, a
 * recorded failover event, and hysteresis-gated recovery on revive.
 *
 * Tuned fast (200ms poll, N=3, M=2) so the arc runs in a few seconds.
 */

import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, fleetReplicas } from "../../src/config.js";
import { launchFleet, type RunningFleet } from "../../src/replica/launch.js";
import { Registry } from "../../src/registry/registry.js";
import { HttpReplicaAdapter } from "../../src/adapter/http.js";
import { HealthScheduler } from "../../src/health/scheduler.js";
import { createRoutingConfig } from "../../src/routing/config.js";
import { createRoutingEngine } from "../../src/routing/engine.js";
import { startStatusServer, type RunningStatusServer } from "../../src/api/server.js";
import { createFailoverLog } from "../../src/events/failover-log.js";

const HOST = "127.0.0.1";
const BASE_PORT = 8301;
const STATUS_PORT = 8310;
const FLEET_SIZE = 3;
const HEALTHY_THRESHOLD = 2;
const INTERVAL_MS = 200;
const TARGET = "replica-2";

let fleet: RunningFleet | undefined;
let status: RunningStatusServer | undefined;
let scheduler: HealthScheduler | undefined;

afterEach(async () => {
  scheduler?.stop();
  await status?.close();
  await fleet?.stop();
  fleet = undefined;
  status = undefined;
  scheduler = undefined;
});

describe("M3 end to end", () => {
  it("loses zero requests, ejects within 1s, records the event, and recovers only after M clean probes", async () => {
    const config = loadConfig({
      WR_HOST: HOST,
      WR_FLEET_SIZE: String(FLEET_SIZE),
      WR_BASE_PORT: String(BASE_PORT),
      WR_STATUS_PORT: String(STATUS_PORT),
      WR_HEALTH_INTERVAL_MS: String(INTERVAL_MS),
      WR_HEALTH_TIMEOUT_MS: "150",
      WR_UNHEALTHY_THRESHOLD: "3",
      WR_HEALTHY_THRESHOLD: String(HEALTHY_THRESHOLD),
      WR_MAX_RETRIES: "2",
    });
    const replicas = fleetReplicas(config);

    fleet = launchFleet(config);
    await Promise.all(replicas.map((r) => waitUntilReachable(r.url, 10_000)));

    const registry = new Registry();
    for (const r of replicas) registry.register(r);

    const adapter = new HttpReplicaAdapter({ replicas, healthTimeoutMs: config.healthTimeoutMs });
    const failoverLog = createFailoverLog({
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
    });

    scheduler = new HealthScheduler({
      adapter,
      sink: registry,
      replicaIds: replicas.map((r) => r.id),
      intervalMs: config.healthIntervalMs,
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
      onTransition: (t) => failoverLog.handleTransition(t),
    });
    scheduler.start();

    const routingConfig = createRoutingConfig({
      strategy: config.routingStrategy,
      weights: config.scoringWeights,
    });
    const engine = createRoutingEngine({ registry, config: routingConfig });

    status = await startStatusServer({
      store: registry,
      engine,
      adapter,
      scheduler,
      failoverLog,
      maxRetries: config.maxRetries,
      port: config.statusPort,
      host: config.host,
    });
    const statusUrl = status.url;

    await waitForAllHealthy(statusUrl, FLEET_SIZE);

    // Continuous load: a handful of workers hitting /route back to back, from
    // before the kill until after the replica has recovered.
    const results: number[] = [];
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        const res = await fetch(`${statusUrl}/route`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: { prompt: "ping" } }),
        });
        results.push(res.status);
        await res.arrayBuffer().catch(() => undefined);
        await sleep(10);
      }
    };
    const workers = Array.from({ length: 4 }, () => worker());

    try {
      // let steady traffic establish before injecting the fault
      await sleep(300);

      const targetUrl = replicas.find((r) => r.id === TARGET)!.url;
      const killedAt = Date.now();
      const kill = await fetch(`${targetUrl}/admin/kill`, { method: "POST" });
      expect(kill.ok).toBe(true);

      // request-driven ejection should land well under 1s, from a live
      // request failure, not the health-poll backstop
      await waitFor(
        () => failoverLog.query({}).some((e) => e.replicaId === TARGET && e.kind === "ejected"),
        1_000,
        "a failover event for the killed replica",
      );
      const ejected = failoverLog
        .query({})
        .find((e) => e.replicaId === TARGET && e.kind === "ejected")!;
      const detectionMs = new Date(ejected.at).getTime() - killedAt;
      expect(detectionMs).toBeLessThan(1_000);
      expect(ejected.trigger).toBe("request_failure");

      // traffic keeps flowing cleanly on the survivors while the replica is down
      await sleep(300);

      const revivedAt = Date.now();
      const revive = await fetch(`${targetUrl}/admin/revive`, { method: "POST" });
      expect(revive.ok).toBe(true);

      await waitFor(
        () => failoverLog.query({}).some((e) => e.replicaId === TARGET && e.kind === "recovered"),
        10_000,
        "the revived replica to recover",
      );
      const recovered = failoverLog
        .query({})
        .find((e) => e.replicaId === TARGET && e.kind === "recovered")!;
      expect(recovered.trigger).toBe("health_check");
      // cannot rejoin on one lucky probe: recovery needs HEALTHY_THRESHOLD (2)
      // consecutive clean probes, so at least one full poll interval must
      // separate the first post-revive probe from the second. The previous
      // version of this assertion (> INTERVAL_MS * 0.5) would pass even if
      // recovery fired on a single probe, since worst-case scheduling jitter
      // alone could plausibly exceed half an interval; requiring a full
      // interval is what actually distinguishes "needed 2 probes" from
      // "needed 1".
      expect(new Date(recovered.at).getTime() - revivedAt).toBeGreaterThanOrEqual(INTERVAL_MS);

      // a little more traffic post-recovery
      await sleep(200);
    } finally {
      // guarantee the workers stop even if an assertion above threw, so they
      // never keep looping against a server `afterEach` is about to close
      stop = true;
      await Promise.all(workers);
    }

    expect(results.length).toBeGreaterThan(20);
    expect(results.every((s) => s === 200)).toBe(true);
  }, 60_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReachable(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`${url}/health`);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`replica at ${url} did not become reachable within ${timeoutMs}ms`);
      }
      await sleep(50);
    }
  }
}

async function waitForAllHealthy(statusUrl: string, count: number): Promise<void> {
  await waitFor(
    async () => {
      const res = await fetch(`${statusUrl}/status`);
      if (!res.ok) return false;
      const snap = (await res.json()) as { replicas: { runtime: { health: string } }[] };
      return (
        snap.replicas.length === count && snap.replicas.every((r) => r.runtime.health === "healthy")
      );
    },
    15_000,
    "all replicas to reach healthy",
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
