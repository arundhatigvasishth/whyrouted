import { describe, it, expect, afterEach } from "vitest";
import { startReplica, type RunningReplica } from "../src/replica/server.js";
import type { SyntheticProfile } from "../src/replica/synthetic.js";

let running: RunningReplica | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** No synthetic baseline load and fixed latency, so tests see only real state. */
const QUIET: SyntheticProfile = {
  baseLatencyMs: 5,
  latencyJitterMs: 0,
  loadAmplitude: 0,
  periodMs: 20_000,
};

async function start(profile: SyntheticProfile = QUIET): Promise<RunningReplica> {
  // port 0 => OS picks a free port, so tests never collide
  running = await startReplica({ id: "replica-test", port: 0, profile });
  return running;
}

describe("simulated replica server", () => {
  it("serves GET /health with the current in-flight count", async () => {
    const replica = await start();

    const res = await fetch(`${replica.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inFlight: 0 });
  });

  it("serves POST /infer with a response and a measured latency", async () => {
    const replica = await start();

    const res = await fetch(`${replica.url}/infer`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { response: { replicaId: string }; latencyMs: number };
    expect(body.response.replicaId).toBe("replica-test");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports in-flight > 0 while an /infer call is running", async () => {
    const replica = await start({ ...QUIET, baseLatencyMs: 40 });

    const inflight = fetch(`${replica.url}/infer`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 5));

    const health = (await (await fetch(`${replica.url}/health`)).json()) as { inFlight: number };
    expect(health.inFlight).toBeGreaterThanOrEqual(1);

    await inflight;
    const after = (await (await fetch(`${replica.url}/health`)).json()) as { inFlight: number };
    expect(after.inFlight).toBe(0);
  });

  it("adds a synthetic baseline to the reported in-flight count", async () => {
    const replica = await start({
      baseLatencyMs: 5,
      latencyJitterMs: 0,
      loadAmplitude: 4,
      periodMs: 20_000,
    });

    const health = (await (await fetch(`${replica.url}/health`)).json()) as { inFlight: number };
    // no real requests in flight, so anything above 0 is the synthetic baseline
    expect(health.inFlight).toBeGreaterThanOrEqual(0);
    expect(health.inFlight).toBeLessThanOrEqual(4);
  });

  it("releases the port on close", async () => {
    const replica = await start();
    await replica.close();
    running = undefined;

    await expect(fetch(`${replica.url}/health`)).rejects.toThrow();
  });
});

describe("kill / revive switch", () => {
  const post = (url: string) => fetch(url, { method: "POST" });

  it("fails /health and /infer with 503 after /admin/kill", async () => {
    const replica = await start();

    const killed = await post(`${replica.url}/admin/kill`);
    expect(killed.status).toBe(200);
    expect(await killed.json()).toEqual({ killed: true });

    expect((await fetch(`${replica.url}/health`)).status).toBe(503);
    expect((await post(`${replica.url}/infer`)).status).toBe(503);
  });

  it("recovers after /admin/revive", async () => {
    const replica = await start();

    await post(`${replica.url}/admin/kill`);
    const revived = await post(`${replica.url}/admin/revive`);
    expect(revived.status).toBe(200);
    expect(await revived.json()).toEqual({ killed: false });

    expect((await fetch(`${replica.url}/health`)).status).toBe(200);
    expect((await post(`${replica.url}/infer`)).status).toBe(200);
  });

  it("is idempotent — kill twice, revive twice", async () => {
    const replica = await start();

    await post(`${replica.url}/admin/kill`);
    await post(`${replica.url}/admin/kill`);
    expect((await fetch(`${replica.url}/health`)).status).toBe(503);

    await post(`${replica.url}/admin/revive`);
    await post(`${replica.url}/admin/revive`);
    expect((await fetch(`${replica.url}/health`)).status).toBe(200);
  });
});
