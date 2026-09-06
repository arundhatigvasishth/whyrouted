import { describe, it, expect, afterEach } from "vitest";
import { startReplica, type RunningReplica } from "../src/replica/server.js";
import { HttpReplicaAdapter } from "../src/adapter/http.js";
import { ReplicaRequestError } from "../src/adapter/types.js";
import type { Replica } from "../src/types.js";

const replicas: RunningReplica[] = [];

afterEach(async () => {
  await Promise.all(replicas.map((r) => r.close()));
  replicas.length = 0;
});

const QUIET = { baseLatencyMs: 5, latencyJitterMs: 0, loadAmplitude: 0, periodMs: 20_000 };

async function spawnReplica(id: string): Promise<Replica> {
  const running = await startReplica({ id, port: 0, profile: QUIET });
  replicas.push(running);
  return { id, url: running.url };
}

describe("HttpReplicaAdapter.checkHealth", () => {
  it("reports a live replica with its in-flight count and a measured latency", async () => {
    const replica = await spawnReplica("replica-1");
    const adapter = new HttpReplicaAdapter({ replicas: [replica], healthTimeoutMs: 500 });

    const result = await adapter.checkHealth("replica-1");
    expect(result.alive).toBe(true);
    expect(result.inFlight).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("resolves (never rejects) with alive:false when the replica is unreachable", async () => {
    const adapter = new HttpReplicaAdapter({
      replicas: [{ id: "dead", url: "http://127.0.0.1:1" }],
      healthTimeoutMs: 300,
    });

    const result = await adapter.checkHealth("dead");
    expect(result).toEqual({ alive: false, latencyMs: 300, inFlight: 0 });
  });

  it("treats a 503 (killed replica) as not alive", async () => {
    const replica = await spawnReplica("replica-1");
    await fetch(`${replica.url}/admin/kill`, { method: "POST" });
    const adapter = new HttpReplicaAdapter({ replicas: [replica], healthTimeoutMs: 500 });

    const result = await adapter.checkHealth("replica-1");
    expect(result.alive).toBe(false);
    expect(result.inFlight).toBe(0);
  });

  it("times out a slow replica and reports the timeout as the latency", async () => {
    // baseLatency well over the timeout, but /health itself is fast — so instead
    // point at a host that will not answer within the timeout
    const adapter = new HttpReplicaAdapter({
      replicas: [{ id: "slow", url: "http://10.255.255.1:80" }],
      healthTimeoutMs: 200,
    });

    const result = await adapter.checkHealth("slow");
    expect(result.alive).toBe(false);
    expect(result.latencyMs).toBe(200);
  });

  it("throws on an unknown replica id", async () => {
    const adapter = new HttpReplicaAdapter({ replicas: [], healthTimeoutMs: 500 });
    await expect(adapter.checkHealth("nope")).rejects.toThrow(/unknown replica/);
  });
});

describe("HttpReplicaAdapter.sendRequest", () => {
  it("returns the replica response and a measured latency", async () => {
    const replica = await spawnReplica("replica-1");
    const adapter = new HttpReplicaAdapter({ replicas: [replica], healthTimeoutMs: 500 });

    const result = await adapter.sendRequest("replica-1", { prompt: "hi" });
    expect(result.response).toMatchObject({ response: { replicaId: "replica-1" } });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects with a retryable http_status error when the replica is killed", async () => {
    const replica = await spawnReplica("replica-1");
    await fetch(`${replica.url}/admin/kill`, { method: "POST" });
    const adapter = new HttpReplicaAdapter({ replicas: [replica], healthTimeoutMs: 500 });

    const err = await adapter.sendRequest("replica-1", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplicaRequestError);
    const rerr = err as ReplicaRequestError;
    expect(rerr.kind).toBe("http_status");
    expect(rerr.status).toBe(503);
    expect(rerr.retryable).toBe(true);
  });

  it("rejects with a retryable connection error when the replica is unreachable", async () => {
    const adapter = new HttpReplicaAdapter({
      replicas: [{ id: "dead", url: "http://127.0.0.1:1" }],
      healthTimeoutMs: 200,
    });

    const err = await adapter.sendRequest("dead", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplicaRequestError);
    expect((err as ReplicaRequestError).kind).toBe("connection");
    expect((err as ReplicaRequestError).retryable).toBe(true);
  });

  it("rejects with a retryable timeout error when the replica is too slow", async () => {
    const slow = { baseLatencyMs: 500, latencyJitterMs: 0, loadAmplitude: 0, periodMs: 20_000 };
    const running = await startReplica({ id: "replica-1", port: 0, profile: slow });
    replicas.push(running);
    const adapter = new HttpReplicaAdapter({
      replicas: [{ id: "replica-1", url: running.url }],
      healthTimeoutMs: 500,
      requestTimeoutMs: 50,
    });

    const err = await adapter.sendRequest("replica-1", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplicaRequestError);
    expect((err as ReplicaRequestError).kind).toBe("timeout");
    expect((err as ReplicaRequestError).retryable).toBe(true);
  });
});
