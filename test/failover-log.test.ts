import { describe, it, expect } from "vitest";
import { createFailoverLog } from "../src/events/failover-log.js";
import type { HealthTransition } from "../src/health/scheduler.js";
import type { FailoverEvent } from "../src/events/types.js";

function log() {
  let n = 0;
  return createFailoverLog({
    unhealthyThreshold: 3,
    healthyThreshold: 2,
    makeId: () => `id-${(n += 1)}`,
  });
}

describe("failover log", () => {
  it("records a request-driven ejection via record()", () => {
    const l = log();
    const event: FailoverEvent = {
      id: "id-1",
      replicaId: "replica-1",
      kind: "ejected",
      at: "2026-09-14T00:00:00.000Z",
      trigger: "request_failure",
      reason: "request failed: timeout",
      requestId: "req-1",
    };
    l.record(event);
    expect(l.query({})).toEqual([event]);
  });

  it("synthesizes a health_check ejection from a poll-driven transition to unhealthy", () => {
    const l = log();
    const transition: HealthTransition = {
      replicaId: "replica-1",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:00:00.000Z",
    };
    l.handleTransition(transition);
    expect(l.query({})).toEqual([
      {
        id: "id-1",
        replicaId: "replica-1",
        kind: "ejected",
        at: "2026-09-14T00:00:00.000Z",
        trigger: "health_check",
        reason: "3 consecutive failed probes",
      },
    ]);
  });

  it("synthesizes a health_check recovery from a poll-driven transition to healthy", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-1",
      from: "unhealthy",
      to: "healthy",
      at: "2026-09-14T00:01:00.000Z",
    });
    expect(l.query({})).toEqual([
      {
        id: "id-1",
        replicaId: "replica-1",
        kind: "recovered",
        at: "2026-09-14T00:01:00.000Z",
        trigger: "health_check",
        reason: "2 consecutive healthy probes",
      },
    ]);
  });

  it("does not record a replica's first unknown -> healthy transition as a recovery", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-1",
      from: "unknown",
      to: "healthy",
      at: "2026-09-14T00:00:00.000Z",
    });
    expect(l.query({})).toEqual([]);
  });

  it("skips a transition that carries a reason, already recorded by the retry loop's direct record()", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-1",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:00:00.000Z",
      reason: "request failed: timeout",
    });
    expect(l.query({})).toEqual([]);
  });

  it("ignores a transition to unknown", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-1",
      from: "healthy",
      to: "unknown",
      at: "2026-09-14T00:00:00.000Z",
    });
    expect(l.query({})).toEqual([]);
  });

  it("queries in ascending order by `at`, regardless of insertion order", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-2",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:02:00.000Z",
    });
    l.handleTransition({
      replicaId: "replica-1",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:01:00.000Z",
    });
    expect(l.query({}).map((e) => e.replicaId)).toEqual(["replica-1", "replica-2"]);
  });

  it("filters by an inclusive from/to range", () => {
    const l = log();
    l.handleTransition({
      replicaId: "replica-1",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:00:00.000Z",
    });
    l.handleTransition({
      replicaId: "replica-1",
      from: "unhealthy",
      to: "healthy",
      at: "2026-09-14T00:05:00.000Z",
    });
    l.handleTransition({
      replicaId: "replica-1",
      from: "healthy",
      to: "unhealthy",
      at: "2026-09-14T00:10:00.000Z",
    });

    expect(
      l.query({ from: "2026-09-14T00:05:00.000Z", to: "2026-09-14T00:05:00.000Z" }),
    ).toHaveLength(1);
    expect(l.query({ from: "2026-09-14T00:05:00.000Z" })).toHaveLength(2);
    expect(l.query({ to: "2026-09-14T00:05:00.000Z" })).toHaveLength(2);
  });
});
