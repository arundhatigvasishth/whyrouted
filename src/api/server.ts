/**
 * whyrouted fleet API server.
 *
 * Two routes:
 *   - `GET /status` (B4, M1): hands back a `RegistrySnapshot` verbatim
 *     (docs/milestones/m1/shared-contract.md, "GET /status response").
 *   - `POST /route` (K11, M2; retry loop added M3, L11): the request-serving
 *     surface. Asks the routing engine for a replica, forwards the caller's
 *     payload to it through the adapter, and returns the replica's response.
 *     On a retryable failure it ejects the replica, records a failover
 *     event, and retries against the next-best replica, up to
 *     `maxRetries` times. Shape fixed by
 *     docs/milestones/m3/shared-contract.md, "L4: POST /route retry behaviour".
 *
 * `/route` is mounted only when an engine, an adapter, a scheduler, a
 * failover log, and a decision log are all supplied, so the M1 status-only
 * server still stands on its own. Reads go through the `RegistryStore`
 * interface and replica calls through `ReplicaAdapter`, so neither the
 * backing store nor the transport is visible here.
 *
 * The decision log (M4, N11) is additive on top of the M3 retry loop: it
 * accumulates one `DecisionRound` per engine call, parallel to the existing
 * `attempts` accumulator, and records exactly one `Decision` when the request
 * resolves. See docs/milestones/m4/shared-contract.md, N4, for the full
 * agreement, including why `chosenReplicaId` is null on a non-retryable
 * failure even though a replica was picked.
 */

import express, { type Express, type ErrorRequestHandler, type Response } from "express";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { Registry } from "../registry/registry.js";
import type { RegistryStore } from "../registry/types.js";
import {
  ReplicaRequestError,
  type ReplicaAdapter,
  type ReplicaErrorKind,
} from "../adapter/types.js";
import type { RoutingEngine, RouteResult } from "../routing/engine.js";
import type { FailoverLog } from "../events/types.js";
import type { DecisionLog, DecisionRound } from "../decisions/types.js";

/** Narrow slice of `HealthScheduler` the retry loop needs (M3, L11). */
export type EjectingScheduler = { eject(replicaId: string, reason: string): void };

/** One failed try, in the order they were attempted. */
export interface RouteAttempt {
  replicaId: string;
  kind: ReplicaErrorKind;
  status?: number;
}

export interface ApiServerDeps {
  /** Where `/status` snapshots are read from. */
  store: RegistryStore;
  /** Routing engine for `/route`. Required together with the other `/route` deps. */
  engine?: RoutingEngine;
  /** Replica adapter for `/route`. Required together with the other `/route` deps. */
  adapter?: ReplicaAdapter;
  /** Ejects a replica on a retryable request failure (M3, L11). Required together with the other `/route` deps. */
  scheduler?: EjectingScheduler;
  /** Records the failover event a retryable failure causes (M3, L11). Required together with the other `/route` deps. */
  failoverLog?: Pick<FailoverLog, "record">;
  /** Records the routing decision every request resolves to (M4, N11). Required together with the other `/route` deps. */
  decisionLog?: Pick<DecisionLog, "record">;
  /** Retries allowed against the next-best replica before giving up. Defaults to `0` (M2 behaviour, no retry). */
  maxRetries?: number;
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
  const { store, engine, adapter, scheduler, failoverLog, decisionLog, maxRetries = 0 } = deps;
  const routeDeps = [engine, adapter, scheduler, failoverLog, decisionLog];
  if (routeDeps.some((d) => d !== undefined) && routeDeps.some((d) => d === undefined)) {
    throw new Error(
      "createStatusApp needs an engine, an adapter, a scheduler, a failoverLog, and a decisionLog together to serve /route, or none of them",
    );
  }

  const app = express();

  // A fresh snapshot per request: `generatedAt` is stamped by the store, and
  // every object in it is already a copy, so nothing here can mutate registry
  // state. 200 + application/json come from `res.json`.
  app.get("/status", (_req, res) => {
    res.json(store.getSnapshot());
  });

  if (
    engine !== undefined &&
    adapter !== undefined &&
    scheduler !== undefined &&
    failoverLog !== undefined &&
    decisionLog !== undefined
  ) {
    app.post("/route", express.json(), (req, res) => {
      void handleRoute(
        { engine, adapter, scheduler, failoverLog, decisionLog, maxRetries },
        (req.body as { payload?: unknown }).payload,
        res,
      );
    });
  }

  // Turns a malformed JSON body from `express.json()` into a clean 400.
  app.use(badJsonBody);

  return app;
}

interface RouteHandlerDeps {
  engine: RoutingEngine;
  adapter: ReplicaAdapter;
  scheduler: EjectingScheduler;
  failoverLog: Pick<FailoverLog, "record">;
  decisionLog: Pick<DecisionLog, "record">;
  maxRetries: number;
}

/** Build the round this engine outcome contributes to the request's Decision (M4, N4). */
function roundFor(decision: RouteResult): DecisionRound {
  if (!decision.ok) {
    return {
      candidates: decision.candidates,
      excluded: decision.excluded,
      strategy: decision.strategy,
      outcome: decision.error,
    };
  }
  return {
    candidates: decision.candidates,
    excluded: decision.excluded,
    strategy: decision.strategy,
    outcome: "picked",
    pickedReplicaId: decision.replicaId,
  };
}

/**
 * The M3 retry loop (L4/L11): ask the engine for a pick excluding every
 * replica already tried this request, forward the payload, and on a
 * retryable `ReplicaRequestError` eject the replica, record the event, and
 * try again, up to `maxRetries` retries (`maxRetries + 1` attempts total). A
 * non-retryable error stops immediately without ejecting; `maxRetries`
 * retries used up returns `503 all_replicas_failed` with the attempt list.
 *
 * M4, N11 additive: each iteration also appends one `DecisionRound` to
 * `rounds`, and exactly once, when the request resolves, records the whole
 * `Decision`. `chosenReplicaId` is set only on a `200`; every failure path,
 * including a non-retryable `502` where a replica was picked but never
 * returned a usable response, records `null` (docs/milestones/m4/shared-contract.md, N4).
 */
async function handleRoute(deps: RouteHandlerDeps, payload: unknown, res: Response): Promise<void> {
  const { engine, adapter, scheduler, failoverLog, decisionLog, maxRetries } = deps;
  const requestId = crypto.randomUUID();
  const attempts: RouteAttempt[] = [];
  const exclude: string[] = [];
  const rounds: DecisionRound[] = [];

  const recordDecision = (chosenReplicaId: string | null): void => {
    decisionLog.record({
      id: crypto.randomUUID(),
      requestId,
      at: new Date().toISOString(),
      rounds,
      chosenReplicaId,
    });
  };

  for (;;) {
    const decision = engine.route({ exclude });
    if (!decision.ok) {
      rounds.push(roundFor(decision));
      recordDecision(null);
      if (attempts.length === 0) {
        // no_healthy_replicas and no_routable_replica pass straight through on
        // a first attempt, so the caller can tell "fleet is down" from
        // "nothing routable yet".
        res.status(503).json({ error: decision.error });
      } else {
        res.status(503).json({ error: "all_replicas_failed", attempts });
      }
      return;
    }

    try {
      const { response, latencyMs } = await adapter.sendRequest(decision.replicaId, payload);
      rounds.push(roundFor(decision));
      recordDecision(decision.replicaId);
      res.json({
        replicaId: decision.replicaId,
        strategy: decision.strategy,
        response,
        latencyMs,
        attempts,
      });
      return;
    } catch (err) {
      if (err instanceof ReplicaRequestError && err.retryable) {
        const reason = `request failed: ${err.kind}${err.status !== undefined ? ` ${err.status}` : ""}`;
        scheduler.eject(decision.replicaId, reason);
        failoverLog.record({
          id: crypto.randomUUID(),
          replicaId: decision.replicaId,
          kind: "ejected",
          at: new Date().toISOString(),
          trigger: "request_failure",
          reason,
          requestId,
        });
        attempts.push({ replicaId: decision.replicaId, kind: err.kind, status: err.status });
        rounds.push({
          ...roundFor(decision),
          failureReason: { kind: err.kind, status: err.status },
        });
        exclude.push(decision.replicaId);

        if (attempts.length > maxRetries) {
          recordDecision(null);
          res.status(503).json({ error: "all_replicas_failed", attempts });
          return;
        }
        continue;
      }

      // Non-retryable (a 4xx `ReplicaRequestError`, or any other error): stop.
      // The replica is not at fault for a 4xx, so it is not ejected.
      rounds.push({
        ...roundFor(decision),
        failureReason:
          err instanceof ReplicaRequestError ? { kind: err.kind, status: err.status } : undefined,
      });
      recordDecision(null);
      res.status(502).json({
        error: "replica_request_failed",
        replicaId: decision.replicaId,
        detail: err instanceof Error ? err.message : String(err),
        attempts,
      });
      return;
    }
  }
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
