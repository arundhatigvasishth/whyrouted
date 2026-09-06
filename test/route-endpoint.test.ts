import { describe, it, expect, afterEach } from "vitest";
import { startStatusServer, createStatusApp, type RunningStatusServer } from "../src/api/server.js";
import { Registry } from "../src/registry/registry.js";
import type { RoutingEngine, RouteResult } from "../src/routing/engine.js";
import type { ReplicaAdapter, HealthResult, SendResult } from "../src/adapter/types.js";

let running: RunningStatusServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Engine stub that returns whatever `RouteResult` the test hands it. */
function fakeEngine(result: RouteResult): RoutingEngine {
  return { route: () => result };
}

interface SendCall {
  replicaId: string;
  payload: unknown;
}

/** Adapter stub that records `sendRequest` calls and resolves or rejects on demand. */
function fakeAdapter(
  send: (call: SendCall) => Promise<SendResult>,
): ReplicaAdapter & { calls: SendCall[] } {
  const calls: SendCall[] = [];
  return {
    calls,
    checkHealth: (): Promise<HealthResult> =>
      Promise.resolve({ alive: true, latencyMs: 1, inFlight: 0 }),
    sendRequest: (replicaId, payload) => {
      const call = { replicaId, payload };
      calls.push(call);
      return send(call);
    },
  };
}

async function start(opts: {
  engine?: RoutingEngine;
  adapter?: ReplicaAdapter;
  store?: Registry;
}): Promise<RunningStatusServer> {
  running = await startStatusServer({
    store: opts.store ?? new Registry(),
    engine: opts.engine,
    adapter: opts.adapter,
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
  it("routes, forwards the payload, and returns the replica response", async () => {
    const adapter = fakeAdapter(() => Promise.resolve({ response: { tokens: 3 }, latencyMs: 14 }));
    const server = await start({
      engine: fakeEngine({ ok: true, replicaId: "replica-2", strategy: "least-loaded" }),
      adapter,
    });

    const res = await postRoute(server.url, { payload: { prompt: "hi" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      replicaId: "replica-2",
      strategy: "least-loaded",
      response: { tokens: 3 },
      latencyMs: 14,
    });
    expect(adapter.calls).toEqual([{ replicaId: "replica-2", payload: { prompt: "hi" } }]);
  });

  it("forwards an undefined payload when the body has none", async () => {
    const adapter = fakeAdapter(() => Promise.resolve({ response: null, latencyMs: 1 }));
    const server = await start({
      engine: fakeEngine({ ok: true, replicaId: "replica-1", strategy: "round-robin" }),
      adapter,
    });

    const res = await postRoute(server.url, {});
    expect(res.status).toBe(200);
    expect(adapter.calls[0]).toEqual({ replicaId: "replica-1", payload: undefined });
  });

  it("returns 503 no_healthy_replicas when the fleet is down", async () => {
    const adapter = fakeAdapter(() => Promise.reject(new Error("should not be called")));
    const server = await start({
      engine: fakeEngine({ ok: false, error: "no_healthy_replicas" }),
      adapter,
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_healthy_replicas" });
    expect(adapter.calls).toEqual([]);
  });

  it("returns 503 no_routable_replica as a distinct body", async () => {
    const server = await start({
      engine: fakeEngine({ ok: false, error: "no_routable_replica" }),
      adapter: fakeAdapter(() => Promise.reject(new Error("should not be called"))),
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_routable_replica" });
  });

  it("returns 502 when the chosen replica's request fails", async () => {
    const server = await start({
      engine: fakeEngine({ ok: true, replicaId: "replica-3", strategy: "least-loaded" }),
      adapter: fakeAdapter(() => Promise.reject(new Error('replica "replica-3" returned 500'))),
    });

    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "replica_request_failed",
      replicaId: "replica-3",
      detail: 'replica "replica-3" returned 500',
    });
  });

  it("returns 400 on a malformed JSON body", async () => {
    const server = await start({
      engine: fakeEngine({ ok: true, replicaId: "replica-1", strategy: "round-robin" }),
      adapter: fakeAdapter(() => Promise.resolve({ response: null, latencyMs: 1 })),
    });

    const res = await postRoute(server.url, "{ not json", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json_body" });
  });

  it("still serves GET /status alongside /route", async () => {
    const server = await start({
      engine: fakeEngine({ ok: false, error: "no_healthy_replicas" }),
      adapter: fakeAdapter(() => Promise.resolve({ response: null, latencyMs: 1 })),
    });

    const res = await fetch(`${server.url}/status`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replicas: unknown[] }).replicas).toEqual([]);
  });
});

describe("createStatusApp wiring", () => {
  it("does not mount /route without an engine and adapter", async () => {
    const server = await start({});
    const res = await postRoute(server.url, { payload: {} });
    expect(res.status).toBe(404);
  });

  it("throws when only one of engine/adapter is supplied", () => {
    expect(() =>
      createStatusApp({
        store: new Registry(),
        engine: fakeEngine({ ok: false, error: "no_healthy_replicas" }),
      }),
    ).toThrow(/both an engine and an adapter/);
  });
});
