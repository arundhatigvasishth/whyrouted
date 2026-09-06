/**
 * M2 integration test (K14).
 *
 * Boots the whole system the way `npm start` does (`src/main.ts` as a real
 * child process, which itself spawns the simulated fleet), then drives
 * `POST /route` end to end and asserts each routing strategy distributes the
 * way it should.
 *
 * One boot per strategy, on its own port range: there is no live-swap endpoint
 * until M5b, so the strategy is fixed at startup via `WR_ROUTING_STRATEGY`.
 * Everything is tuned fast (300ms poll, N=2, M=2) so each arc runs in seconds.
 *
 * The synthetic profiles from K7 (`profileForIndex`) give `replica-1` the
 * smallest load amplitude and lowest base latency, `replica-3` the largest, so
 * the load-aware strategies have a real gradient to sort on.
 */

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RegistrySnapshot } from "../../src/types.js";

const mainScript = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "main.ts");
const HOST = "127.0.0.1";

interface Scenario {
  strategy: string;
  basePort: number;
  statusPort: number;
}

function envFor({ strategy, basePort, statusPort }: Scenario): Record<string, string> {
  return {
    WR_HOST: HOST,
    WR_FLEET_SIZE: "3",
    WR_BASE_PORT: String(basePort),
    WR_STATUS_PORT: String(statusPort),
    WR_HEALTH_INTERVAL_MS: "300",
    WR_HEALTH_TIMEOUT_MS: "200",
    WR_UNHEALTHY_THRESHOLD: "2",
    WR_HEALTHY_THRESHOLD: "2",
    WR_ROUTING_STRATEGY: strategy,
  };
}

interface RouteBody {
  replicaId?: string;
  strategy?: string;
  error?: string;
}

describe("M2 end to end", () => {
  it("round-robin cycles through the healthy replicas in order and drops a killed one", async () => {
    const scenario: Scenario = { strategy: "round-robin", basePort: 8221, statusPort: 8220 };
    const proc = bootMain(scenario);
    const statusUrl = `http://${HOST}:${scenario.statusPort}`;

    try {
      await waitForAllHealthy(statusUrl, 3);

      const picks: string[] = [];
      for (let i = 0; i < 9; i += 1) picks.push(await routeTo(statusUrl));
      expect(picks).toEqual([
        "replica-1",
        "replica-2",
        "replica-3",
        "replica-1",
        "replica-2",
        "replica-3",
        "replica-1",
        "replica-2",
        "replica-3",
      ]);

      // kill replica-2 and wait for the scheduler to drop it
      const kill = await fetch(`http://${HOST}:${scenario.basePort + 1}/admin/kill`, {
        method: "POST",
      });
      expect(kill.ok).toBe(true);
      await waitFor(
        async () => (await healthOf(statusUrl, "replica-2")) === "unhealthy",
        10_000,
        "replica-2 to go unhealthy",
      );

      const afterKill: string[] = [];
      for (let i = 0; i < 8; i += 1) afterKill.push(await routeTo(statusUrl));
      expect(afterKill).not.toContain("replica-2");
      expect(new Set(afterKill)).toEqual(new Set(["replica-1", "replica-3"]));
    } finally {
      await stopTree(proc);
    }
  }, 90_000);

  it("least-loaded concentrates routes on the lowest-load replica", async () => {
    const scenario: Scenario = { strategy: "least-loaded", basePort: 8231, statusPort: 8230 };
    const proc = bootMain(scenario);
    const statusUrl = `http://${HOST}:${scenario.statusPort}`;

    try {
      await waitForAllHealthy(statusUrl, 3);

      const counts = await routeManyAndCount(statusUrl, 15);
      // replica-1 has the smallest synthetic load amplitude, so least-loaded
      // should hand it the clear majority (in practice it takes nearly all 15).
      expect(counts["replica-1"] ?? 0).toBeGreaterThan(counts["replica-2"] ?? 0);
      expect(counts["replica-1"] ?? 0).toBeGreaterThan(counts["replica-3"] ?? 0);
      expect(counts["replica-1"] ?? 0).toBeGreaterThanOrEqual(9);
    } finally {
      await stopTree(proc);
    }
  }, 90_000);

  it("latency-weighted also favours the lowest-cost replica", async () => {
    const scenario: Scenario = { strategy: "latency-weighted", basePort: 8241, statusPort: 8240 };
    const proc = bootMain(scenario);
    const statusUrl = `http://${HOST}:${scenario.statusPort}`;

    try {
      await waitForAllHealthy(statusUrl, 3);

      // 30 samples, not 15: the registry snapshot only updates every 300ms
      // (the health-poll interval), so a burst of requests inside one poll
      // window all see the same inFlight/latencyMs and a single noisy
      // /health round-trip can flip the score for that whole window. A
      // bigger sample dilutes one bad window instead of being dominated by it.
      const counts = await routeManyAndCount(statusUrl, 30);
      // Health-probe latency is near-equal across the fleet (only /infer is
      // slow), so the load term dominates and replica-1 still wins. What this
      // asserts is that latency-weighted runs cleanly against real registry
      // data and picks sensibly, not a latency-specific ordering.
      expect(counts["replica-1"] ?? 0).toBeGreaterThan(counts["replica-3"] ?? 0);
      expect(counts["replica-1"] ?? 0).toBeGreaterThanOrEqual(16);
    } finally {
      await stopTree(proc);
    }
  }, 90_000);
});

function bootMain(scenario: Scenario): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", mainScript], {
    env: { ...process.env, ...envFor(scenario) },
    stdio: "inherit",
  });
}

/** Send one `POST /route` and return the replica id it was routed to. Fails loudly on a non-200. */
async function routeTo(statusUrl: string): Promise<string> {
  const res = await fetch(`${statusUrl}/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload: { prompt: "ping" } }),
  });
  const body = (await res.json()) as RouteBody;
  if (res.status !== 200 || body.replicaId === undefined) {
    throw new Error(`POST /route returned ${res.status} ${JSON.stringify(body)}`);
  }
  return body.replicaId;
}

async function routeManyAndCount(statusUrl: string, n: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const id = await routeTo(statusUrl);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

async function getStatus(statusUrl: string): Promise<RegistrySnapshot | undefined> {
  try {
    const res = await fetch(`${statusUrl}/status`);
    if (!res.ok) return undefined;
    return (await res.json()) as RegistrySnapshot;
  } catch {
    return undefined; // server not up yet
  }
}

async function healthOf(statusUrl: string, replicaId: string): Promise<string | undefined> {
  const snap = await getStatus(statusUrl);
  return snap?.replicas.find((r) => r.id === replicaId)?.runtime.health;
}

async function waitForAllHealthy(statusUrl: string, count: number): Promise<void> {
  await waitFor(
    async () => (await getStatus(statusUrl))?.replicas.length === count,
    20_000,
    "registry to populate",
  );
  await waitFor(
    async () => {
      const snap = await getStatus(statusUrl);
      return snap !== undefined && snap.replicas.every((r) => r.runtime.health === "healthy");
    },
    15_000,
    "all replicas to reach healthy",
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Stop `main` and everything it spawned. SIGTERM on POSIX lets main's shutdown
 *  handler tear the fleet down; Windows has no such signal, so kill the tree. */
async function stopTree(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    if (process.platform === "win32" && proc.pid !== undefined) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    } else {
      proc.kill("SIGTERM");
    }
    setTimeout(() => proc.kill("SIGKILL"), 8_000).unref();
  });
}
