import { describe, it, expect, afterEach } from "vitest";
import { startReplica, type RunningReplica } from "../src/replica/server.js";

let running: RunningReplica | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(): Promise<RunningReplica> {
  // port 0 => OS picks a free port, so tests never collide
  running = await startReplica({ id: "replica-test", port: 0 });
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
    const replica = await start();

    const inflight = fetch(`${replica.url}/infer`, { method: "POST" });
    // give the request a moment to land and bump the counter
    await new Promise((r) => setTimeout(r, 2));

    const health = (await (await fetch(`${replica.url}/health`)).json()) as { inFlight: number };
    expect(health.inFlight).toBeGreaterThanOrEqual(1);

    await inflight;
    const after = (await (await fetch(`${replica.url}/health`)).json()) as { inFlight: number };
    expect(after.inFlight).toBe(0);
  });

  it("releases the port on close", async () => {
    const replica = await start();
    await replica.close();
    running = undefined;

    await expect(fetch(`${replica.url}/health`)).rejects.toThrow();
  });
});
