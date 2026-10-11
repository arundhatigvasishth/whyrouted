import { afterEach, describe, expect, it } from "vitest";
import { startReplica, type RunningReplica } from "../src/replica/server.js";
import { createHttpFaultInjector, FAULT_MODES } from "../src/replica/fault-injector.js";
import type { SyntheticProfile } from "../src/replica/synthetic.js";

const QUIET: SyntheticProfile = {
  baseLatencyMs: 5,
  latencyJitterMs: 0,
  loadAmplitude: 0,
  periodMs: 20_000,
};

let replica: RunningReplica | undefined;

afterEach(async () => {
  await replica?.close();
  replica = undefined;
});

async function start() {
  replica = await startReplica({ id: "replica-1", port: 0, profile: QUIET });
  const injector = createHttpFaultInjector({
    replicas: [{ id: "replica-1", url: replica.url }],
  });
  return { url: replica.url, injector };
}

const healthStatus = async (url: string) => (await fetch(`${url}/health`)).status;
const inferStatus = async (url: string) => (await fetch(`${url}/infer`, { method: "POST" })).status;

describe("HTTP fault injector against a real simulated replica", () => {
  it("lists the three modes", () => {
    expect([...FAULT_MODES]).toEqual(["kill", "fail_infer", "revive"]);
  });

  it("kill fails health and inference, and reports the replica's own state", async () => {
    const { url, injector } = await start();
    expect(await injector.inject("replica-1", "kill")).toEqual({
      killed: true,
      inferFailing: false,
    });
    expect(await healthStatus(url)).toBe(503);
    expect(await inferStatus(url)).toBe(503);
  });

  it("fail_infer fails only inference, leaving health fine", async () => {
    const { url, injector } = await start();
    expect(await injector.inject("replica-1", "fail_infer")).toEqual({
      killed: false,
      inferFailing: true,
    });
    expect(await healthStatus(url)).toBe(200);
    expect(await inferStatus(url)).toBe(503);
  });

  it("revive clears either fault", async () => {
    const { url, injector } = await start();
    await injector.inject("replica-1", "kill");
    expect(await injector.inject("replica-1", "revive")).toEqual({
      killed: false,
      inferFailing: false,
    });
    expect(await healthStatus(url)).toBe(200);
    expect(await inferStatus(url)).toBe(200);

    await injector.inject("replica-1", "fail_infer");
    await injector.inject("replica-1", "revive");
    expect(await inferStatus(url)).toBe(200);
  });

  it("reports the replica's state, not the mode: fail_infer after kill shows both", async () => {
    const { injector } = await start();
    await injector.inject("replica-1", "kill");
    expect(await injector.inject("replica-1", "fail_infer")).toEqual({
      killed: true,
      inferFailing: true,
    });
  });

  it("is idempotent: killing a killed replica succeeds and reports the same state", async () => {
    const { injector } = await start();
    const first = await injector.inject("replica-1", "kill");
    expect(await injector.inject("replica-1", "kill")).toEqual(first);
  });
});

describe("HTTP fault injector errors", () => {
  it("throws for a replica it has no endpoint for", async () => {
    const injector = createHttpFaultInjector({ replicas: [] });
    await expect(injector.inject("replica-9", "kill")).rejects.toThrow(/replica-9/);
  });

  it("throws when the replica is unreachable", async () => {
    const injector = createHttpFaultInjector({
      replicas: [{ id: "replica-1", url: "http://127.0.0.1:1" }],
      timeoutMs: 500,
    });
    await expect(injector.inject("replica-1", "kill")).rejects.toThrow();
  });

  it("throws on a non-2xx answer rather than inventing a state", async () => {
    const injector = createHttpFaultInjector({
      replicas: [{ id: "replica-1", url: "http://x" }],
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    await expect(injector.inject("replica-1", "kill")).rejects.toThrow(/answered 500/);
  });

  it("throws on a body that is not a fault state", async () => {
    for (const body of [{}, { killed: true }, { killed: "yes", inferFailing: false }, "text"]) {
      const injector = createHttpFaultInjector({
        replicas: [{ id: "replica-1", url: "http://x" }],
        fetchImpl: (async () => Response.json(body)) as typeof fetch,
      });
      await expect(injector.inject("replica-1", "kill"), JSON.stringify(body)).rejects.toThrow(
        /unexpected body/,
      );
    }
  });

  it("posts to the right admin path for each mode", async () => {
    const seen: string[] = [];
    const injector = createHttpFaultInjector({
      replicas: [{ id: "replica-1", url: "http://127.0.0.1:9001" }],
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(`${init?.method} ${String(url)}`);
        return Response.json({ killed: false, inferFailing: false });
      }) as typeof fetch,
    });
    for (const mode of FAULT_MODES) await injector.inject("replica-1", mode);
    expect(seen).toEqual([
      "POST http://127.0.0.1:9001/admin/kill",
      "POST http://127.0.0.1:9001/admin/fail-infer",
      "POST http://127.0.0.1:9001/admin/revive",
    ]);
  });
});
