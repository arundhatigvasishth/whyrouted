/**
 * Simulated replica server (A1).
 *
 * A real, standalone HTTP server that stands in for one model replica. Phase 2
 * swaps these for real Ollama / vLLM servers behind the same HTTP surface, so
 * nothing above the adapter boundary changes — that swap is the project's core
 * architectural bet (PRD §6).
 *
 * HTTP surface (docs/m1/m1-shared-contract.md, "Simulated replica HTTP surface"):
 *   GET  /health  -> 200 { inFlight }        — liveness + self-reported load
 *   POST /infer   -> 200 { response, latencyMs } — synthetic inference call
 *
 * Not here yet:
 *   - POST /admin/kill, POST /admin/revive   — kill / revive switch
 *   - spawning a fleet of these              — src/replica/launch.ts
 */

import express, { type Express } from "express";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createSynthetic, type SyntheticProfile } from "./synthetic.js";

export interface ReplicaOptions {
  /** Stable id, e.g. "replica-1". Echoed back in /infer responses and logs. */
  id: string;
  /** Port to bind. */
  port: number;
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string;
  /** Synthetic load/latency profile. Defaults to `DEFAULT_PROFILE`. */
  profile?: SyntheticProfile;
}

export interface RunningReplica {
  readonly id: string;
  readonly url: string;
  /** Stop the server and resolve once the port is released. */
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the Express app for one replica. Exposed separately from
 * {@link startReplica} so tests can drive it without binding a port.
 */
export function createReplicaApp(id: string, profile?: SyntheticProfile): Express {
  const app = express();
  app.use(express.json());

  const synthetic = createSynthetic(profile);

  /** Concurrent /infer calls in progress right now. */
  let inFlight = 0;

  app.get("/health", (_req, res) => {
    // real concurrent load plus the replica's slow synthetic baseline
    res.json({ inFlight: inFlight + synthetic.baselineLoad() });
  });

  app.post("/infer", async (_req, res) => {
    inFlight += 1;
    const startedAt = performance.now();
    try {
      await sleep(synthetic.latencyMs());
      res.json({
        response: { replicaId: id, servedAt: new Date().toISOString() },
        latencyMs: Math.round(performance.now() - startedAt),
      });
    } finally {
      inFlight -= 1;
    }
  });

  return app;
}

/** Start a replica server and wait until it is accepting connections. */
export async function startReplica(opts: ReplicaOptions): Promise<RunningReplica> {
  const host = opts.host ?? "127.0.0.1";
  const app = createReplicaApp(opts.id, opts.profile);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, host, () => resolve(s));
    s.once("error", reject);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
  const url = `http://${host}:${port}`;

  return {
    id: opts.id,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** `tsx src/replica/server.ts` — run one replica from WR_REPLICA_* env vars. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.env.WR_REPLICA_ID ?? "replica";
  const port = Number(process.env.WR_REPLICA_PORT ?? 8001);
  startReplica({ id, port })
    .then((replica) => console.log(`${replica.id} listening on ${replica.url}`))
    .catch((err: unknown) => {
      console.error(`failed to start replica: ${String(err)}`);
      process.exitCode = 1;
    });
}
