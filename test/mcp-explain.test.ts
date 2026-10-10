import { describe, expect, it } from "vitest";
import type { Decision, DecisionRound } from "../src/decisions/types.js";
import { createDecisionLog } from "../src/decisions/decision-log.js";
import type { CandidateScore } from "../src/routing/types.js";
import {
  createExplainRoutingDecision,
  explainDecision,
  resolveCite,
  type ExplanationLine,
} from "../src/mcp/tools/explain-routing-decision.js";
import { dispatch } from "../src/mcp/types.js";

const cand = (replicaId: string, score: number, inFlight = 0): CandidateScore => ({
  replicaId,
  inFlight,
  latencyMs: 10,
  score,
  considered: true,
});

const round = (over: Partial<DecisionRound>): DecisionRound => ({
  candidates: [],
  excluded: [],
  strategy: "least-loaded",
  outcome: "picked",
  ...over,
});

function decision(over: Partial<Decision>): Decision {
  return {
    id: "dec-1",
    requestId: "req-1",
    at: "2026-09-29T12:00:00.000Z",
    rounds: [],
    chosenReplicaId: null,
    ...over,
  };
}

const singleRound = decision({
  chosenReplicaId: "alpha",
  rounds: [
    round({
      candidates: [cand("beta", 3), cand("alpha", 1)],
      excluded: [{ replicaId: "gamma", reason: "unhealthy" }],
      pickedReplicaId: "alpha",
    }),
  ],
});

const retried = decision({
  requestId: "req-retry",
  chosenReplicaId: "beta",
  rounds: [
    round({
      candidates: [cand("alpha", 0), cand("beta", 3)],
      pickedReplicaId: "alpha",
      failureReason: { kind: "http_status", status: 500 },
    }),
    round({
      candidates: [cand("beta", 3)],
      excluded: [{ replicaId: "alpha", reason: "already_tried" }],
      pickedReplicaId: "beta",
    }),
  ],
});

const roundRobin = decision({
  chosenReplicaId: "alpha",
  rounds: [
    round({
      strategy: "round-robin",
      candidates: [cand("beta", 1), cand("alpha", 0)],
      pickedReplicaId: "alpha",
    }),
  ],
});

const fleetDown = decision({
  rounds: [
    round({
      strategy: "latency-weighted",
      outcome: "no_healthy_replicas",
      excluded: [{ replicaId: "alpha", reason: "unhealthy" }],
    }),
  ],
});

const failedAll = decision({
  rounds: [
    round({
      candidates: [cand("alpha", 0)],
      pickedReplicaId: "alpha",
      failureReason: { kind: "timeout" },
    }),
    round({
      outcome: "no_routable_replica",
      excluded: [{ replicaId: "alpha", reason: "already_tried" }],
    }),
  ],
});

/** Flatten whatever a cite resolves to into the strings it can justify in text. */
function citedStrings(decision: Decision, lines: ExplanationLine[]): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (Array.isArray(v)) out.add(String(v.length));
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(add);
    else if (v !== undefined) out.add(String(v));
  };
  for (const l of lines) for (const c of l.cites) add(resolveCite(decision, c));
  return out;
}

/** The grounding rule: every cite resolves, and every id and number in a line's text is cited. */
function expectGrounded(d: Decision): void {
  const { lines } = explainDecision(d);
  const ids = new Set<string>();
  if (d.chosenReplicaId) ids.add(d.chosenReplicaId);
  for (const r of d.rounds) {
    if (r.pickedReplicaId) ids.add(r.pickedReplicaId);
    r.candidates.forEach((c) => ids.add(c.replicaId));
    r.excluded.forEach((e) => ids.add(e.replicaId));
  }
  for (const line of lines) {
    expect(line.cites.length).toBeGreaterThan(0);
    for (const c of line.cites) expect(resolveCite(d, c), `${c} in "${line.text}"`).toBeDefined();
    const cited = citedStrings(d, [line]);
    let text = line.text;
    for (const id of [...ids].sort((a, b) => b.length - a.length)) {
      if (text.includes(id)) expect(cited.has(id), `${id} cited in "${line.text}"`).toBe(true);
      text = text.split(id).join(" ");
    }
    text = text.replace(/Round \d+/g, " ");
    for (const n of text.match(/\d+(\.\d+)?/g) ?? []) {
      expect(cited.has(n), `${n} cited in "${line.text}"`).toBe(true);
    }
  }
}

describe("explainDecision", () => {
  it("explains a single-round success from recorded values, lowest score first", () => {
    const { decision: echoed, lines } = explainDecision(singleRound);
    expect(echoed).toBe(singleRound);
    expect(lines.map((l) => l.text)).toEqual([
      "Served by alpha after 1 round.",
      "Round 1 (least-loaded): picked alpha (score 1) over beta (score 3). Excluded: gamma (unhealthy).",
    ]);
  });

  it("surfaces the whole retry story, including why the first round failed", () => {
    const { lines } = explainDecision(retried);
    expect(lines.map((l) => l.text)).toEqual([
      "Served by beta after 2 rounds.",
      "Round 1 (least-loaded): picked alpha (score 0) over beta (score 3). It then failed with http_status 500.",
      "Round 2 (least-loaded): picked beta (score 3). Excluded: alpha (already_tried).",
    ]);
  });

  it("describes round-robin by rotation position, never as lowest load", () => {
    const [, line] = explainDecision(roundRobin).lines;
    expect(line!.text).toBe(
      "Round 1 (round-robin): picked alpha (rotation position 0), then in rotation: beta (rotation position 1).",
    );
    expect(line!.text).not.toMatch(/load|latency|lowest/);
  });

  it("does not credit a strategy with a round where the fleet had no healthy replica", () => {
    const { lines } = explainDecision(fleetDown);
    expect(lines.map((l) => l.text)).toEqual([
      "No replica returned a usable response, after 1 round.",
      "Round 1: the registry had no healthy replica. Excluded: alpha (unhealthy).",
    ]);
    expect(lines[1]!.text).not.toContain("latency-weighted");
  });

  it("reports a failed request and a round with nothing routable, without inventing a cause", () => {
    const { lines } = explainDecision(failedAll);
    expect(lines.map((l) => l.text)).toEqual([
      "No replica returned a usable response, after 2 rounds.",
      "Round 1 (least-loaded): picked alpha (score 0). It then failed with timeout.",
      "Round 2 (least-loaded): no replica could be picked; 0 candidates scored. Excluded: alpha (already_tried).",
    ]);
  });

  it("says nothing about a replica the record does not mention", () => {
    // latency-weighted skips a candidate with no latency measurement (N1): it
    // is in neither candidates nor excluded, so it must get no sentence.
    const d = decision({
      chosenReplicaId: "alpha",
      rounds: [
        round({
          strategy: "latency-weighted",
          candidates: [cand("alpha", 12)],
          pickedReplicaId: "alpha",
        }),
      ],
    });
    const text = explainDecision(d)
      .lines.map((l) => l.text)
      .join(" ");
    expect(text).not.toContain("skipped");
    expect(text).not.toContain("unknown");
  });

  it("handles a decision with no rounds", () => {
    expect(explainDecision(decision({})).lines).toEqual([
      { text: "The record contains no rounds.", cites: ["rounds"] },
    ]);
  });

  it.each([
    ["single round", singleRound],
    ["retried", retried],
    ["round-robin", roundRobin],
    ["fleet down", fleetDown],
    ["failed after retries", failedAll],
  ])("every cite resolves and every id and number in the text is cited: %s", (_name, d) => {
    expectGrounded(d);
  });
});

describe("explain_routing_decision tool", () => {
  function setup() {
    const decisionLog = createDecisionLog();
    decisionLog.record(retried);
    let now = 0;
    const call = dispatch(createExplainRoutingDecision({ decisionLog }), {
      now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, now++)),
    });
    return { call };
  }

  it("returns the decision, its lines, and grounding for a recorded request", async () => {
    const { call } = setup();
    const res = await call({ request_id: "req-retry" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.decision).toEqual(retried);
    expect(res.data.lines).toHaveLength(3);
    expect(res.groundedIn).toEqual({
      source: "decision_log",
      queriedAt: "2026-09-29T12:00:00.000Z",
      recordIds: ["dec-1"],
    });
  });

  it("says so for an unknown request id, without claiming it never happened", async () => {
    const { call } = setup();
    const res = await call({ request_id: "nope" });
    expect(res).toEqual({
      ok: false,
      code: "no_data",
      reason: 'no decision recorded for request id "nope"',
    });
    expect(res.ok === false && res.reason).not.toMatch(/never|no such/i);
  });

  it("does not match a similar-looking request id", async () => {
    const { call } = setup();
    expect((await call({ request_id: "req-retr" })).ok).toBe(false);
    expect((await call({ request_id: "REQ-RETRY" })).ok).toBe(false);
  });

  it("rejects an empty or missing request id as invalid_input", async () => {
    const { call } = setup();
    for (const bad of ["", "   "]) {
      expect(await call({ request_id: bad })).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(await call({} as never)).toMatchObject({ ok: false, code: "invalid_input" });
  });
});
