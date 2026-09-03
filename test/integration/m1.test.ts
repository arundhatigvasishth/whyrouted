/**
 * M1 integration test (J4).
 *
 * Boots the whole system the way `npm start` does — `src/main.ts` as a real
 * child process, which itself spawns the simulated fleet — then drives the M1
 * demo end to end through the two public surfaces only: each replica's
 * `/admin/kill` + `/admin/revive`, and whyrouted's `GET /status`.
 *
 * Asserts the contract that makes M1 "done":
 *   - the registry populates with every replica and they all reach `healthy`
 *   - killing a replica shows up as `unhealthy` in `/status` (others unaffected)
 *   - reviving it recovers to `healthy`
 *
 * Everything is tuned fast (400ms poll, N=3, M=2) so the arc runs in seconds.
 */

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RegistrySnapshot } from "../../src/types.js";

const mainScript = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "main.ts");

const HOST = "127.0.0.1";
const BASE_PORT = 8201;
const STATUS_PORT = 8210;

const ENV = {
  WR_HOST: HOST,
  WR_FLEET_SIZE: "3",
  WR_BASE_PORT: String(BASE_PORT),
  WR_STATUS_PORT: String(STATUS_PORT),
  WR_HEALTH_INTERVAL_MS: "400",
  WR_HEALTH_TIMEOUT_MS: "300",
  WR_UNHEALTHY_THRESHOLD: "3",
  WR_HEALTHY_THRESHOLD: "2",
};

const STATUS_URL = `http://${HOST}:${STATUS_PORT}/status`;
const replicaUrl = (n: number): string => `http://${HOST}:${BASE_PORT + n - 1}`;

describe("M1 end to end", () => {
  it("brings the fleet up, reflects a kill in /status, and recovers on revive", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", mainScript], {
      env: { ...process.env, ...ENV },
      stdio: "inherit",
    });

    try {
      // 1. the registry populates with all three replicas
      await waitFor(
        async () => (await getStatus())?.replicas.length === 3,
        20_000,
        "registry to populate",
      );

      // 2. all three probe healthy
      await waitFor(
        async () => {
          const snap = await getStatus();
          return snap !== undefined && snap.replicas.every((r) => r.runtime.health === "healthy");
        },
        15_000,
        "all replicas to reach healthy",
      );

      // 3. kill replica-2
      const kill = await fetch(`${replicaUrl(2)}/admin/kill`, { method: "POST" });
      expect(kill.ok).toBe(true);

      // 4. /status shows replica-2 unhealthy
      await waitFor(
        async () => (await healthOf("replica-2")) === "unhealthy",
        15_000,
        "replica-2 to go unhealthy",
      );

      // ...and the other two are untouched
      expect(await healthOf("replica-1")).toBe("healthy");
      expect(await healthOf("replica-3")).toBe("healthy");

      // 5. revive replica-2
      const revive = await fetch(`${replicaUrl(2)}/admin/revive`, { method: "POST" });
      expect(revive.ok).toBe(true);

      // 6. replica-2 recovers to healthy
      await waitFor(
        async () => (await healthOf("replica-2")) === "healthy",
        15_000,
        "replica-2 to recover",
      );
    } finally {
      await stopTree(proc);
    }
  }, 90_000);
});

async function getStatus(): Promise<RegistrySnapshot | undefined> {
  try {
    const res = await fetch(STATUS_URL);
    if (!res.ok) return undefined;
    return (await res.json()) as RegistrySnapshot;
  } catch {
    return undefined; // server not up yet
  }
}

async function healthOf(replicaId: string): Promise<string | undefined> {
  const snap = await getStatus();
  return snap?.replicas.find((r) => r.id === replicaId)?.runtime.health;
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
