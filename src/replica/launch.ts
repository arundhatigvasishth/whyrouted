/**
 * Fleet launcher.
 *
 * Spawns the simulated fleet — one real child process per replica, each running
 * `server.ts` on its own port (`basePort .. basePort + fleetSize - 1`). Real
 * separate processes, not in-process instances: that's what makes the Phase 2
 * swap to real Ollama / vLLM servers a config change rather than a rewrite.
 *
 * `npm run start:fleet` runs this from the environment config. `main.ts` (J3)
 * calls `launchFleet` directly so it can shut the fleet down with the rest of
 * the process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, fleetReplicas, type Config } from "../config.js";
import { profileForIndex, type SyntheticProfile } from "./synthetic.js";

const serverScript = join(dirname(fileURLToPath(import.meta.url)), "server.ts");

export interface FleetMember {
  id: string;
  url: string;
  pid: number | undefined;
}

export interface RunningFleet {
  members: FleetMember[];
  /** SIGTERM every child and resolve once they have all exited. */
  stop(): Promise<void>;
}

/** How a single replica process is started. Swapped for a fake in tests. */
export type Spawner = (
  id: string,
  port: number,
  host: string,
  profile: SyntheticProfile,
) => ChildProcess;

const defaultSpawner: Spawner = (id, port, host, profile) =>
  spawn(process.execPath, ["--import", "tsx", serverScript], {
    env: {
      ...process.env,
      WR_REPLICA_ID: id,
      WR_REPLICA_PORT: String(port),
      WR_HOST: host,
      WR_REPLICA_PROFILE: JSON.stringify(profile),
    },
    stdio: "inherit",
  });

/**
 * Start every replica in the fleet. Returns immediately with a handle — the
 * children are still booting; poll their `/health` endpoints to know when they
 * are ready.
 */
export function launchFleet(config: Config, spawner: Spawner = defaultSpawner): RunningFleet {
  const children: ChildProcess[] = [];

  const members = fleetReplicas(config).map((replica, i) => {
    const child = spawner(replica.id, config.basePort + i, config.host, profileForIndex(i));
    child.on("exit", (code) => {
      if (code) console.error(`${replica.id} exited with code ${code}`);
    });
    children.push(child);
    return { id: replica.id, url: replica.url, pid: child.pid };
  });

  return {
    members,
    stop: () =>
      Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.once("exit", () => resolve());
              child.kill("SIGTERM");
            }),
        ),
      ).then(() => undefined),
  };
}

/** `npm run start:fleet` — launch from env config and run until interrupted. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const fleet = launchFleet(config);
  const top = config.basePort + fleet.members.length - 1;
  console.log(
    `launched ${fleet.members.length} replicas on ${config.host}:${config.basePort}-${top}`,
  );

  const shutdown = (): void => {
    fleet.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
