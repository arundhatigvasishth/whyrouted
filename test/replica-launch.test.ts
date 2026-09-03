import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { launchFleet, type Spawner } from "../src/replica/launch.js";
import { loadConfig } from "../src/config.js";

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 100_000);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

describe("launchFleet (fake spawner)", () => {
  const config = loadConfig({ WR_FLEET_SIZE: "3", WR_BASE_PORT: "9000", WR_HOST: "127.0.0.1" });

  it("spawns one process per replica on consecutive ports", () => {
    const calls: Array<{ id: string; port: number; host: string }> = [];
    const spawner: Spawner = (id, port, host) => {
      calls.push({ id, port, host });
      return new FakeChild() as unknown as ChildProcess;
    };

    const fleet = launchFleet(config, spawner);

    expect(calls).toEqual([
      { id: "replica-1", port: 9000, host: "127.0.0.1" },
      { id: "replica-2", port: 9001, host: "127.0.0.1" },
      { id: "replica-3", port: 9002, host: "127.0.0.1" },
    ]);
    expect(fleet.members.map((m) => m.url)).toEqual([
      "http://127.0.0.1:9000",
      "http://127.0.0.1:9001",
      "http://127.0.0.1:9002",
    ]);
    expect(fleet.members.every((m) => typeof m.pid === "number")).toBe(true);
  });

  it("stop() kills every child and resolves once they exit", async () => {
    const children: FakeChild[] = [];
    const spawner: Spawner = () => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    };

    const fleet = launchFleet(config, spawner);
    await fleet.stop();

    expect(children).toHaveLength(3);
    expect(children.every((c) => c.killed)).toBe(true);
  });
});

describe("launchFleet (real processes)", () => {
  it("boots a fleet that answers /health, then shuts it down", async () => {
    const config = loadConfig({ WR_FLEET_SIZE: "2", WR_BASE_PORT: "8123", WR_HOST: "127.0.0.1" });
    const fleet = launchFleet(config);

    try {
      for (const member of fleet.members) {
        await waitForHealth(`${member.url}/health`, 15_000);
      }
      expect(fleet.members).toHaveLength(2);
    } finally {
      await fleet.stop();
    }

    await new Promise((r) => setTimeout(r, 200));
    await expect(fetch(`${fleet.members[0]!.url}/health`)).rejects.toThrow();
  }, 30_000);
});

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
