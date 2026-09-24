import { describe, it, expect } from "vitest";
import { createDecisionLog } from "../src/decisions/decision-log.js";
import type { Decision } from "../src/decisions/types.js";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "id-1",
    requestId: "req-1",
    at: "2026-09-23T00:00:00.000Z",
    rounds: [
      {
        candidates: [],
        excluded: [],
        strategy: "least-loaded",
        outcome: "picked",
        pickedReplicaId: "replica-1",
      },
    ],
    chosenReplicaId: "replica-1",
    ...overrides,
  };
}

describe("decision log", () => {
  it("records and returns a decision via record()/query()", () => {
    const log = createDecisionLog();
    const d = decision();
    log.record(d);
    expect(log.query({})).toEqual([d]);
  });

  it("looks up a decision by requestId via get()", () => {
    const log = createDecisionLog();
    const d = decision({ requestId: "req-42" });
    log.record(d);
    expect(log.get("req-42")).toEqual(d);
  });

  it("returns undefined from get() for a requestId that was never recorded", () => {
    const log = createDecisionLog();
    log.record(decision({ requestId: "req-1" }));
    expect(log.get("req-2")).toBeUndefined();
  });

  it("queries in ascending order by `at`, regardless of insertion order", () => {
    const log = createDecisionLog();
    log.record(decision({ id: "id-2", requestId: "req-2", at: "2026-09-23T00:02:00.000Z" }));
    log.record(decision({ id: "id-1", requestId: "req-1", at: "2026-09-23T00:01:00.000Z" }));
    expect(log.query({}).map((d) => d.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("filters by an inclusive from/to range", () => {
    const log = createDecisionLog();
    log.record(decision({ id: "id-1", requestId: "req-1", at: "2026-09-23T00:00:00.000Z" }));
    log.record(decision({ id: "id-2", requestId: "req-2", at: "2026-09-23T00:05:00.000Z" }));
    log.record(decision({ id: "id-3", requestId: "req-3", at: "2026-09-23T00:10:00.000Z" }));

    expect(
      log.query({ from: "2026-09-23T00:05:00.000Z", to: "2026-09-23T00:05:00.000Z" }),
    ).toHaveLength(1);
    expect(log.query({ from: "2026-09-23T00:05:00.000Z" })).toHaveLength(2);
    expect(log.query({ to: "2026-09-23T00:05:00.000Z" })).toHaveLength(2);
  });

  it("keeps every round of a multi-round decision, in order", () => {
    const log = createDecisionLog();
    const d = decision({
      rounds: [
        {
          candidates: [],
          excluded: [],
          strategy: "least-loaded",
          outcome: "picked",
          pickedReplicaId: "replica-1",
          failureReason: { kind: "timeout" },
        },
        {
          candidates: [],
          excluded: [{ replicaId: "replica-1", reason: "already_tried" }],
          strategy: "least-loaded",
          outcome: "picked",
          pickedReplicaId: "replica-2",
        },
      ],
      chosenReplicaId: "replica-2",
    });
    log.record(d);
    expect(log.get("req-1")?.rounds).toHaveLength(2);
    expect(log.get("req-1")?.rounds[1]?.excluded).toEqual([
      { replicaId: "replica-1", reason: "already_tried" },
    ]);
  });
});
