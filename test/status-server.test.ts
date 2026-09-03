import { describe, it, expect, afterEach } from "vitest";
import { startStatusServer, type RunningStatusServer } from "../src/api/server.js";
import { Registry } from "../src/registry/registry.js";
import { initialRuntime } from "../src/types.js";

let running: RunningStatusServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Start the status server on an OS-picked port so tests never collide. */
async function start(store: Registry): Promise<RunningStatusServer> {
  running = await startStatusServer({ store, port: 0 });
  return running;
}

describe("GET /status", () => {
  it("returns 200 application/json", async () => {
    const server = await start(new Registry());

    const res = await fetch(`${server.url}/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns an empty snapshot before anything is registered", async () => {
    const server = await start(new Registry());

    const body = (await (await fetch(`${server.url}/status`)).json()) as {
      generatedAt: string;
      replicas: unknown[];
    };
    expect(body.replicas).toEqual([]);
    expect(body.generatedAt).toBe(new Date(Date.parse(body.generatedAt)).toISOString());
  });

  it("returns the full snapshot for a seeded registry, in registration order", async () => {
    const reg = new Registry();
    reg.register({ id: "replica-1", url: "http://127.0.0.1:8001" });
    reg.register({ id: "replica-2", url: "http://127.0.0.1:8002" });
    reg.updateRuntime("replica-1", {
      inFlight: 3,
      latencyMs: 12,
      consecSuccesses: 5,
      lastCheckedAt: "2026-09-01T16:19:59.500Z",
    });
    reg.setHealth("replica-1", "healthy");

    const server = await start(reg);
    const body = (await (await fetch(`${server.url}/status`)).json()) as {
      replicas: { id: string; url: string; runtime: Record<string, unknown> }[];
    };

    expect(body.replicas.map((r) => r.id)).toEqual(["replica-1", "replica-2"]);
    expect(body.replicas[0]).toEqual({
      id: "replica-1",
      url: "http://127.0.0.1:8001",
      runtime: {
        health: "healthy",
        inFlight: 3,
        latencyMs: 12,
        consecFailures: 0,
        consecSuccesses: 5,
        lastCheckedAt: "2026-09-01T16:19:59.500Z",
      },
    });
    expect(body.replicas[1]).toEqual({
      id: "replica-2",
      url: "http://127.0.0.1:8002",
      runtime: initialRuntime(),
    });
  });

  it("reflects registry changes on the next request", async () => {
    const reg = new Registry();
    reg.register({ id: "replica-1", url: "http://127.0.0.1:8001" });
    const server = await start(reg);

    const before = (await (await fetch(`${server.url}/status`)).json()) as {
      replicas: { runtime: { health: string } }[];
    };
    expect(before.replicas[0]!.runtime.health).toBe("unknown");

    reg.setHealth("replica-1", "unhealthy");

    const after = (await (await fetch(`${server.url}/status`)).json()) as {
      replicas: { runtime: { health: string } }[];
    };
    expect(after.replicas[0]!.runtime.health).toBe("unhealthy");
  });

  it("stamps a fresh generatedAt on each request", async () => {
    const server = await start(new Registry());

    const first = (await (await fetch(`${server.url}/status`)).json()) as { generatedAt: string };
    await new Promise((r) => setTimeout(r, 5));
    const second = (await (await fetch(`${server.url}/status`)).json()) as { generatedAt: string };

    expect(Date.parse(second.generatedAt)).toBeGreaterThanOrEqual(Date.parse(first.generatedAt));
  });
});
