/**
 * whyrouted main process (M1, J3).
 *
 * Wires the two tracks together: load config, start the simulated fleet, wait
 * for it to come up, register every replica in the registry, start the health
 * scheduler polling through the HTTP adapter, and expose `GET /status`.
 *
 * Everything below depends on the shared contract (`src/adapter/types.ts`,
 * `src/types.ts`) only — swapping the registry backend or the adapter
 * implementation later does not touch this file's shape.
 */

import { loadConfig, fleetReplicas } from "./config.js";
import { launchFleet, type RunningFleet } from "./replica/launch.js";
import { Registry } from "./registry/registry.js";
import { HttpReplicaAdapter } from "./adapter/http.js";
import { HealthScheduler } from "./health/scheduler.js";
import { startStatusServer, type RunningStatusServer } from "./api/server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a replica's `/health` until it answers (any status) or the timeout elapses. */
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

async function main(): Promise<void> {
  const config = loadConfig();
  const replicas = fleetReplicas(config);

  const fleet: RunningFleet = launchFleet(config);
  await Promise.all(replicas.map((r) => waitUntilReachable(r.url, 5000)));
  console.log(
    `fleet up: ${fleet.members.length} replicas on ${config.host}:${config.basePort}-${config.basePort + fleet.members.length - 1}`,
  );

  const registry = new Registry();
  for (const replica of replicas) {
    registry.register(replica);
  }

  const adapter = new HttpReplicaAdapter({
    replicas,
    healthTimeoutMs: config.healthTimeoutMs,
  });

  const scheduler = new HealthScheduler({
    adapter,
    sink: registry,
    replicaIds: replicas.map((r) => r.id),
    intervalMs: config.healthIntervalMs,
    unhealthyThreshold: config.unhealthyThreshold,
    healthyThreshold: config.healthyThreshold,
    onTransition: (t) => console.log(`${t.replicaId}: ${t.from} -> ${t.to}`),
  });
  scheduler.start();

  const status: RunningStatusServer = await startStatusServer({
    store: registry,
    port: config.statusPort,
    host: config.host,
  });
  console.log(`status server listening on ${status.url}/status`);

  const shutdown = (): void => {
    console.log("shutting down...");
    scheduler.stop();
    Promise.all([status.close(), fleet.stop()])
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`error during shutdown: ${String(err)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(`whyrouted failed to start: ${String(err)}`);
  process.exitCode = 1;
});
