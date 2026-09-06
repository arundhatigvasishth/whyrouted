/**
 * whyrouted fleet API server.
 *
 * Two routes:
 *   - `GET /status` (B4, M1): hands back a `RegistrySnapshot` verbatim
 *     (docs/milestones/m1/shared-contract.md, "GET /status response").
 *   - `POST /route` (K11, M2): the request-serving surface. Asks the routing
 *     engine for a replica, forwards the caller's payload to it through the
 *     adapter, and returns the replica's response. Shape fixed by
 *     docs/milestones/m2/shared-contract.md, "POST /route".
 *
 * `/route` is mounted only when both an engine and an adapter are supplied, so
 * the M1 status-only server still stands on its own. Reads go through the
 * `RegistryStore` interface and replica calls through `ReplicaAdapter`, so
 * neither the backing store nor the transport is visible here.
 */

import express, { type Express, type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Registry } from "../registry/registry.js";
import type { RegistryStore } from "../registry/types.js";
import type { ReplicaAdapter } from "../adapter/types.js";
import type { RoutingEngine } from "../routing/engine.js";

export interface ApiServerDeps {
  /** Where `/status` snapshots are read from. */
  store: RegistryStore;
  /** Routing engine for `/route`. Required together with `adapter`. */
  engine?: RoutingEngine;
  /** Replica adapter for `/route`. Required together with `engine`. */
  adapter?: ReplicaAdapter;
}

export interface StatusServerOptions extends ApiServerDeps {
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

const badJsonBody: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "invalid_json_body" });
    return;
  }
  next(err);
};

/**
 * Build the Express app. Exposed separately from {@link startStatusServer} so
 * tests can drive it without binding a port.
 */
export function createStatusApp(deps: ApiServerDeps): Express {
  const { store, engine, adapter } = deps;
  if ((engine === undefined) !== (adapter === undefined)) {
    throw new Error(
      "createStatusApp needs both an engine and an adapter to serve /route, or neither",
    );
  }

  const app = express();

  // A fresh snapshot per request: `generatedAt` is stamped by the store, and
  // every object in it is already a copy, so nothing here can mutate registry
  // state. 200 + application/json come from `res.json`.
  app.get("/status", (_req, res) => {
    res.json(store.getSnapshot());
  });

  if (engine !== undefined && adapter !== undefined) {
    app.post("/route", express.json(), (req, res) => {
      const payload = (req.body as { payload?: unknown }).payload;

      const decision = engine.route();
      if (!decision.ok) {
        // no_healthy_replicas and no_routable_replica pass straight through, so
        // the caller can tell "fleet is down" from "nothing routable yet".
        res.status(503).json({ error: decision.error });
        return;
      }

      adapter.sendRequest(decision.replicaId, payload).then(
        ({ response, latencyMs }) => {
          res.json({
            replicaId: decision.replicaId,
            strategy: decision.strategy,
            response,
            latencyMs,
          });
        },
        (err: unknown) => {
          // The engine picked a healthy replica but the request itself failed.
          // M2 has no failover (that's M3), so this is terminal for the request.
          res.status(502).json({
            error: "replica_request_failed",
            replicaId: decision.replicaId,
            detail: err instanceof Error ? err.message : String(err),
          });
        },
      );
    });
  }

  // Turns a malformed JSON body from `express.json()` into a clean 400.
  app.use(badJsonBody);

  return app;
}

/** Start the server and wait until it is accepting connections. */
export async function startStatusServer(opts: StatusServerOptions): Promise<RunningStatusServer> {
  const host = opts.host ?? "127.0.0.1";
  const app = createStatusApp(opts);

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
