/**
 * `GET /status` server (B4).
 *
 * The fleet's one read endpoint for M1: it answers a single route by handing
 * back a `RegistrySnapshot` verbatim (docs/m1/m1-shared-contract.md, "GET
 * /status response"). No auth, no query params, no other routes — M2's router
 * adds the request-serving surface.
 *
 * It reads through the `RegistryStore` interface, not the concrete `Registry`,
 * so the backing store (in-memory now, Redis later) is invisible here. The
 * scheduler owns writes; this server only ever calls `getSnapshot()`.
 *
 * `main.ts` (J3) passes `config.statusPort` as `port` — this module never sees
 * the whole `Config`.
 */

import express, { type Express } from "express";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Registry } from "../registry/registry.js";
import type { RegistryStore } from "../registry/types.js";

export interface StatusServerOptions {
  /** Where snapshots are read from. */
  store: RegistryStore;
  /** Port to bind. `0` lets the OS pick a free one (used by tests). */
  port: number;
  /** Host to bind. Defaults to 127.0.0.1. */
  host?: string;
}

export interface RunningStatusServer {
  readonly url: string;
  readonly port: number;
  /** Stop the server and resolve once the port is released. */
  close(): Promise<void>;
}

/**
 * Build the Express app. Exposed separately from {@link startStatusServer} so
 * tests can drive it without binding a port.
 */
export function createStatusApp(store: RegistryStore): Express {
  const app = express();

  // A fresh snapshot per request — `generatedAt` is stamped by the store, and
  // every object in it is already a copy, so nothing here can mutate registry
  // state. 200 + application/json come from `res.json`.
  app.get("/status", (_req, res) => {
    res.json(store.getSnapshot());
  });

  return app;
}

/** Start the status server and wait until it is accepting connections. */
export async function startStatusServer(opts: StatusServerOptions): Promise<RunningStatusServer> {
  const host = opts.host ?? "127.0.0.1";
  const app = createStatusApp(opts.store);

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, host, () => resolve(s));
    s.once("error", reject);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** `tsx src/api/server.ts` — run the status server against an empty registry. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WR_STATUS_PORT ?? 8080);
  startStatusServer({ store: new Registry(), port })
    .then((s) => console.log(`status server listening on ${s.url}/status`))
    .catch((err: unknown) => {
      console.error(`failed to start status server: ${String(err)}`);
      process.exitCode = 1;
    });
}
