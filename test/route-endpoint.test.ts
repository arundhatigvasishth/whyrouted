import { describe, it, expect, afterEach } from "vitest";
import {
  startStatusServer,
  createStatusApp,
  type RunningStatusServer,
  type EjectingScheduler,
} from "../src/api/server.js";
import { Registry } from "../src/registry/registry.js";
import type { RoutingEngine, RouteResult, RouteOptions } from "../src/routing/engine.js";
import {
  ReplicaRequestError,
  type ReplicaAdapter,
  type HealthResult,
  type SendResult,
} from "../src/adapter/types.js";
import type { FailoverEvent, FailoverLog } from "../src/events/types.js";

let running: RunningStatusServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Engine stub whose `route` is driven by a queue of results, one per call. */
function fakeEngine(
  results: RouteResult[],
): RoutingEngine & { calls: (RouteOptions | undefined)[] } {
  const calls: (RouteOptions | undefined)[] = [];
  let i = 0;
  return {
    calls,
    route: (opts?: RouteOptions) => {
      // snapshot: the caller's `exclude` array is mutated after this call returns
      calls.push(opts?.exclude !== undefined ? { exclude: [...opts.exclude] } : opts);
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return result;
    },
  };
}

interface SendCall {
  replicaId: string;
  payload: unknown;
}

/** Adapter stub driven by a queue of resolve/reject outcomes, one per `sendRequest` call. */
function fakeAdapter(
  outcomes: (() => Promise<SendResult>)[],
): ReplicaAdapter & { calls: SendCall[] } {
  const calls: SendCall[] = [];
  let i = 0;
  return {
    calls,
    checkHealth: (): Promise<HealthResult> =>
      Promise.resolve({ alive: true, latencyMs: 1, inFlight: 0 }),
    sendRequest: (replicaId, payload) => {
      calls.push({ replicaId, payload });
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      return outcome();
    },
  };
}

function fakeScheduler(): EjectingScheduler & { ejected: { replicaId: string; reason: string }[] } {
  const ejected: { replicaId: string; reason: string }[] = [];
  return {
    ejected,
    eject: (replicaId, reason) => {
      ejected.push({ replicaId, reason });
    },
  };
}

function fakeFailoverLog(): Pick<FailoverLog, "record"> & { events: FailoverEvent[] } {
  const events: FailoverEvent[] = [];
  return {
    events,
    record: (event) => {
      events.push(event);
    },
  };
}

async function start(opts: {
  engine?: RoutingEngine;
  adapter?: ReplicaAdapter;
  scheduler?: EjectingScheduler;
  failoverLog?: Pick<FailoverLog, "record">;
  maxRetries?: number;
  store?: Registry;
}): Promise<RunningStatusServer> {
  running = await startStatusServer({
    store: opts.store ?? new Registry(),
    engine: opts.engine,
    adapter: opts.adapter,
    scheduler: opts.scheduler,
    failoverLog: opts.failoverLog,
    maxRetries: opts.maxRetries,
    port: 0,
  });
  return running;
}

function postRoute(url: string, body: unknown, raw = false): Promise<Response> {
  return fetch(`${url}/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("POST /route", () => {
  it("routes, forwards the payload, and returns the replica response with an empty attempts list", async () => {
    const adapter = fakeAdapter([
      () => Promise.resolve({ response: { tokens: 3 }, latencyMs: 14 }),
    ]);
    const server = await start({
      engine: fakeEngine([{ ok: true, replicaId: "replica-2", strategy: "least-loaded" }]),
      adapter,
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await postRoute(server.url, { payload: { prompt: "hi" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replicaId: "replica-2",
      strategy: "least-loaded",
      response: { tokens: 3 },
      latencyMs: 14,
      attempts: [],
    });
    expect(adapter.calls).toEqual([{ replicaId: "replica-2", payload: { prompt: "hi" } }]);
  });

  it("forwards an undefined payload when the body has none", async () => {
    const adapter = fakeAdapter([() => Promise.resolve({ response: null, latencyMs: 1 })]);
    const server = await start({
      engine: fakeEngine([{ ok: true, replicaId: "replica-1", strategy: "round-robin" }]),
      adapter,
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await postRoute(server.url, {});
    expect(res.status).toBe(200);
    expect(adapter.calls[0]).toEqual({ replicaId: "replica-1", payload: undefined });
  });

  it("returns 503 no_healthy_replicas on the first attempt when the fleet is down", async () => {
    const adapter = fakeAdapter([() => Promise.reject(new Error("should not be called"))]);
    const server = await start({
      engine: fakeEngine([{ ok: false, error: "no_healthy_replicas" }]),
      adapter,
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_healthy_replicas" });
    expect(adapter.calls).toEqual([]);
  });

  it("returns 503 no_routable_replica as a distinct body", async () => {
    const server = await start({
      engine: fakeEngine([{ ok: false, error: "no_routable_replica" }]),
      adapter: fakeAdapter([() => Promise.reject(new Error("should not be called"))]),
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_routable_replica" });
  });

  it("retries against the next-best replica on a retryable failure, ejects and records it", async () => {
    const adapter = fakeAdapter([
      () => Promise.reject(new ReplicaRequestError("timeout", 'replica "replica-1" timed out')),
      () => Promise.resolve({ response: { ok: true }, latencyMs: 5 }),
    ]);
    const engine = fakeEngine([
      { ok: true, replicaId: "replica-1", strategy: "least-loaded" },
      { ok: true, replicaId: "replica-2", strategy: "least-loaded" },
    ]);
    const scheduler = fakeScheduler();
    const failoverLog = fakeFailoverLog();
    const server = await start({ engine, adapter, scheduler, failoverLog, maxRetries: 2 });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replicaId: "replica-2",
      strategy: "least-loaded",
      response: { ok: true },
      latencyMs: 5,
      attempts: [{ replicaId: "replica-1", kind: "timeout" }],
    });

    expect(scheduler.ejected).toEqual([
      { replicaId: "replica-1", reason: "request failed: timeout" },
    ]);
    expect(failoverLog.events).toHaveLength(1);
    expect(failoverLog.events[0]).toMatchObject({
      replicaId: "replica-1",
      kind: "ejected",
      trigger: "request_failure",
      reason: "request failed: timeout",
    });
    expect(engine.calls).toEqual([{ exclude: [] }, { exclude: ["replica-1"] }]);
  });

  it("returns 503 all_replicas_failed with the full attempt list once maxRetries is exhausted", async () => {
    const adapter = fakeAdapter([
      () => Promise.reject(new ReplicaRequestError("connection", "replica-1 unreachable")),
      () => Promise.reject(new ReplicaRequestError("http_status", "replica-2 returned 503", 503)),
      () => Promise.reject(new ReplicaRequestError("timeout", "replica-3 timed out")),
    ]);
    const engine = fakeEngine([
      { ok: true, replicaId: "replica-1", strategy: "round-robin" },
      { ok: true, replicaId: "replica-2", strategy: "round-robin" },
      { ok: true, replicaId: "replica-3", strategy: "round-robin" },
    ]);
    const scheduler = fakeScheduler();
    const failoverLog = fakeFailoverLog();
    const server = await start({ engine, adapter, scheduler, failoverLog, maxRetries: 2 });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "all_replicas_failed",
      attempts: [
        { replicaId: "replica-1", kind: "connection" },
        { replicaId: "replica-2", kind: "http_status", status: 503 },
        { replicaId: "replica-3", kind: "timeout" },
      ],
    });
    expect(scheduler.ejected).toHaveLength(3);
    expect(failoverLog.events).toHaveLength(3);
  });

  it("stops without retrying or ejecting on a non-retryable 4xx error", async () => {
    const adapter = fakeAdapter([
      () => Promise.reject(new ReplicaRequestError("http_status", "replica-1 returned 400", 400)),
    ]);
    const scheduler = fakeScheduler();
    const failoverLog = fakeFailoverLog();
    const server = await start({
      engine: fakeEngine([{ ok: true, replicaId: "replica-1", strategy: "least-loaded" }]),
      adapter,
      scheduler,
      failoverLog,
      maxRetries: 2,
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "replica_request_failed",
      replicaId: "replica-1",
      detail: "replica-1 returned 400",
      attempts: [],
    });
    expect(scheduler.ejected).toEqual([]);
    expect(failoverLog.events).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it("returns 400 on a malformed JSON body", async () => {
    const server = await start({
      engine: fakeEngine([{ ok: true, replicaId: "replica-1", strategy: "round-robin" }]),
      adapter: fakeAdapter([() => Promise.resolve({ response: null, latencyMs: 1 })]),
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await postRoute(server.url, "{ not json", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json_body" });
  });

  it("still serves GET /status alongside /route", async () => {
    const server = await start({
      engine: fakeEngine([{ ok: false, error: "no_healthy_replicas" }]),
      adapter: fakeAdapter([() => Promise.resolve({ response: null, latencyMs: 1 })]),
      scheduler: fakeScheduler(),
      failoverLog: fakeFailoverLog(),
    });

    const res = await fetch(`${server.url}/status`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replicas: unknown[] }).replicas).toEqual([]);
  });
});

describe("createStatusApp wiring", () => {
  it("does not mount /route without the route deps", async () => {
    const server = await start({});
    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(404);
  });

  it("throws when only some of the route deps are supplied", () => {
    expect(() =>
      createStatusApp({
        store: new Registry(),
        engine: fakeEngine([{ ok: false, error: "no_healthy_replicas" }]),
      }),
    ).toThrow(/engine, an adapter, a scheduler, and a failoverLog/);
  });
});
