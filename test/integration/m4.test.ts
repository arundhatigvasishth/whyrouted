/**
 * M4 integration test (N16, joint task).
 *
 * Builds the whole system the way `main.ts` wires it, in-process rather than
 * through a `main.ts` child process, same reasoning as the M3 test
 * (test/integration/m3.test.ts): it needs a live reference to the
 * `DecisionLog` instance to assert on recorded decisions directly, and
 * `explain_routing_decision`'s HTTP surface doesn't exist yet (M5a).
 *
 * Round-robin is used instead of the default least-loaded so which replica
 * gets picked each call is deterministic (a fixed cursor cycle), letting the
 * test correlate exact requests to exact decisions without guessing at a
 * load-based pick.
 *
 * Requests are driven one at a time, awaited in full before the next fires.
 * `handleRoute` records a request's `Decision` synchronously before writing
 * the HTTP response (src/api/server.ts), so sequential, non-overlapping
 * calls guarantee `decisionLog.query({})` comes back in the same order the
 * requests were made, which is what lets this test match "decision N" to
 * "the Nth request's response" by position instead of by requestId (never
 * returned to the client, that's also M5a territory).
 *
 * Finding worth recording here rather than silently working around: the task
 * split (docs/milestones/m4/task-split.md, N16) expected a retried request's
 * excluded replica to show `reason: "already_tried"`. It never does, live.
 * `POST /route`'s retry loop always calls `scheduler.eject()` on a retryable
 * failure before looping (src/api/server.ts), and eject() is synchronous, so
 * by the time the engine's next `route()` call runs, the replica is already
 * `unhealthy` in the registry, not just excluded. Per N3's tie-break
 * ("unhealthy wins" when a replica is both), it reports `unhealthy`. This
 * test asserts the real behaviour; `already_tried` remains reachable at the
 * engine unit-test level (test/routing-engine.test.ts) by calling
 * `route({ exclude })` directly against a replica the test keeps healthy,
 * but is not observable through the live retry path as built.
 */

import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, fleetReplicas } from "../../src/config.js";
import { launchFleet, type RunningFleet } from "../../src/replica/launch.js";
import { Registry } from "../../src/registry/registry.js";
import { HttpReplicaAdapter } from "../../src/adapter/http.js";
import { HealthScheduler } from "../../src/health/scheduler.js";
import { createRoutingConfig } from "../../src/routing/config.js";
import { createRoutingEngine } from "../../src/routing/engine.js";
import { startStatusServer, type RunningStatusServer } from "../../src/api/server.js";
import { createFailoverLog } from "../../src/events/failover-log.js";
import { createDecisionLog } from "../../src/decisions/decision-log.js";
import type { DecisionLog } from "../../src/decisions/types.js";

const HOST = "127.0.0.1";
const BASE_PORT = 8401;
const STATUS_PORT = 8410;
const FLEET_SIZE = 3;
const TARGET = "replica-3";

let fleet: RunningFleet | undefined;
let status: RunningStatusServer | undefined;
let scheduler: HealthScheduler | undefined;

afterEach(async () => {
  scheduler?.stop();
  await status?.close();
  await fleet?.stop();
  fleet = undefined;
  status = undefined;
  scheduler = undefined;
});

interface RouteResponse {
  status: number;
  body: { replicaId?: string; error?: string };
}

describe("M4 end to end", () => {
  it("records one decision per request, with a full candidate set and correct exclusion reasons", async () => {
    const config = loadConfig({
      WR_HOST: HOST,
      WR_FLEET_SIZE: String(FLEET_SIZE),
      WR_BASE_PORT: String(BASE_PORT),
      WR_STATUS_PORT: String(STATUS_PORT),
      WR_HEALTH_INTERVAL_MS: "200",
      WR_HEALTH_TIMEOUT_MS: "150",
      WR_UNHEALTHY_THRESHOLD: "3",
      WR_HEALTHY_THRESHOLD: "2",
      WR_MAX_RETRIES: "2",
      WR_ROUTING_STRATEGY: "round-robin",
    });
    const replicas = fleetReplicas(config);
    const replicaIds = replicas.map((r) => r.id);

    fleet = launchFleet(config);
    await Promise.all(replicas.map((r) => waitUntilReachable(r.url, 10_000)));

    const registry = new Registry();
    for (const r of replicas) registry.register(r);

    const adapter = new HttpReplicaAdapter({ replicas, healthTimeoutMs: config.healthTimeoutMs });
    const failoverLog = createFailoverLog({
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
    });
    const decisionLog: DecisionLog = createDecisionLog();

    scheduler = new HealthScheduler({
      adapter,
      sink: registry,
      replicaIds,
      intervalMs: config.healthIntervalMs,
      unhealthyThreshold: config.unhealthyThreshold,
      healthyThreshold: config.healthyThreshold,
      onTransition: (t) => failoverLog.handleTransition(t),
    });
    scheduler.start();

    const routingConfig = createRoutingConfig({
      strategy: config.routingStrategy,
      weights: config.scoringWeights,
    });
    const engine = createRoutingEngine({ registry, config: routingConfig });

    status = await startStatusServer({
      store: registry,
      engine,
      adapter,
      scheduler,
      failoverLog,
      decisionLog,
      maxRetries: config.maxRetries,
      port: config.statusPort,
      host: config.host,
    });
    const statusUrl = status.url;

    await waitForAllHealthy(statusUrl, FLEET_SIZE);

    const route = async (): Promise<RouteResponse> => {
      const res = await fetch(`${statusUrl}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { prompt: "ping" } }),
      });
      const body = (await res.json()) as RouteResponse["body"];
      return { status: res.status, body };
    };

    // Round-robin, cursor 0 -> 1 -> 2: replica-1, replica-2, replica-3.
    const r1 = await route();
    const r2 = await route();

    const targetUrl = replicas.find((r) => r.id === TARGET)!.url;
    const kill = await fetch(`${targetUrl}/admin/kill`, { method: "POST" });
    expect(kill.ok).toBe(true);

    // Cursor is now at 2, so this call's first pick is the just-killed
    // replica-3: `/admin/kill` makes it answer with a 503, not refuse the
    // connection (src/replica/server.ts), a retryable http_status failure,
    // one retry against a survivor.
    const r3 = await route();
    expect(r3.status).toBe(200);
    expect(r3.body.replicaId).not.toBe(TARGET);

    // Two more, target still excluded (unhealthy) on both.
    const r4 = await route();
    const r5 = await route();

    const responses = [r1, r2, r3, r4, r5];
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const decisions = decisionLog.query({});
    expect(decisions).toHaveLength(5);

    // chosenReplicaId matches what the client actually got back, in order
    // (N16's core assertion): the decision log and the HTTP responses agree
    // on where every request actually went.
    expect(decisions.map((d) => d.chosenReplicaId)).toEqual(responses.map((r) => r.body.replicaId));

    // Every decision id is unique: one Decision per request, not reused.
    expect(new Set(decisions.map((d) => d.id)).size).toBe(5);

    // The three pre-kill/first-attempt decisions are single-round, and their
    // one round's candidate set covers every currently-healthy replica with
    // a real score, nothing excluded yet.
    for (const d of [decisions[0]!, decisions[1]!]) {
      expect(d.rounds).toHaveLength(1);
      const [round] = d.rounds;
      expect(round!.excluded).toEqual([]);
      expect(round!.candidates.map((c) => c.replicaId).sort()).toEqual(replicaIds);
      for (const c of round!.candidates) {
        expect(c.considered).toBe(true);
        expect(typeof c.score).toBe("number");
      }
    }

    // r3's decision: two rounds. Round 1 picked the (about to be discovered
    // dead) target against the full 3-replica pool; round 2 retried against
    // the survivors.
    const retried = decisions[2]!;
    expect(retried.rounds).toHaveLength(2);
    const [round1, round2] = retried.rounds;
    expect(round1!.pickedReplicaId).toBe(TARGET);
    expect(round1!.excluded).toEqual([]);
    expect(round1!.candidates.map((c) => c.replicaId).sort()).toEqual(replicaIds);
    expect(round1!.failureReason).toMatchObject({ kind: "http_status", status: 503 });

    expect(round2!.pickedReplicaId).toBe(retried.chosenReplicaId);
    expect(round2!.failureReason).toBeUndefined();
    // See the file header: this is "unhealthy", not the task split's
    // originally expected "already_tried", because eject() has already run
    // by the time this round's engine.route() call happens.
    expect(round2!.excluded).toEqual([{ replicaId: TARGET, reason: "unhealthy" }]);
    // Every replica the registry knows about is accounted for in this round:
    // the two candidates plus the one excluded cover all three (N3's
    // engine-level invariant).
    expect(
      [
        ...round2!.candidates.map((c) => c.replicaId),
        ...round2!.excluded.map((e) => e.replicaId),
      ].sort(),
    ).toEqual(replicaIds);

    // r4 and r5: target still unhealthy, excluded the same way on every
    // subsequent single-round decision, not just the one that discovered it.
    for (const d of [decisions[3]!, decisions[4]!]) {
      expect(d.rounds).toHaveLength(1);
      const [round] = d.rounds;
      expect(round!.excluded).toEqual([{ replicaId: TARGET, reason: "unhealthy" }]);
      expect(round!.candidates.map((c) => c.replicaId)).not.toContain(TARGET);
    }
  }, 30_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReachable(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`${url}/health`);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`replica at ${url} did not become reachable within ${timeoutMs}ms`);
      }
      await sleep(50);
    }
  }
}

async function waitForAllHealthy(statusUrl: string, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await fetch(`${statusUrl}/status`);
    if (res.ok) {
      const snap = (await res.json()) as { replicas: { runtime: { health: string } }[] };
      if (
        snap.replicas.length === count &&
        snap.replicas.every((r) => r.runtime.health === "healthy")
      ) {
        return;
      }
    }
    if (Date.now() > deadline)
      throw new Error("timed out waiting for all replicas to reach healthy");
    await sleep(25);
  }
}
