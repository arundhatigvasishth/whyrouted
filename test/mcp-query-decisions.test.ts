import { describe, expect, it } from "vitest";
import type { Decision } from "../src/decisions/types.js";
import { createDecisionLog } from "../src/decisions/decision-log.js";
import { aggregate, createQueryDecisions } from "../src/mcp/tools/query-decisions.js";
import { dispatch } from "../src/mcp/types.js";

const REQ = "3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const decision = (n: number, over: Partial<Decision>): Decision => ({
  id: `dec-${n}`,
  requestId: `req-${n}`,
  at: `2026-09-29T15:0${n}:00.000Z`,
  rounds: [],
  chosenReplicaId: null,
  ...over,
});

const served = (n: number, replica: string, latencyMs?: number) =>
  decision(n, { chosenReplicaId: replica, ...(latencyMs !== undefined ? { latencyMs } : {}) });

const WINDOW = { from: "2026-09-29T15:00:00.000Z", to: "2026-09-29T15:10:00.000Z" };

const IN_RANGE = "between 2026-09-29T15:00:00Z and 2026-09-29T15:10:00Z";

function setup(decisions: Decision[]) {
  const decisionLog = createDecisionLog();
  for (const d of decisions) decisionLog.record(d);
  const now = () => new Date("2026-09-29T16:00:00.000Z");
  const call = dispatch(createQueryDecisions({ decisionLog, now }), { now });
  return { call, ask: (q: string) => call({ natural_language_query: q }) };
}

describe("aggregate", () => {
  it("counts served and failed and tallies served per replica", () => {
    const data = aggregate(
      [served(1, "alpha", 10), served(2, "alpha", 20), served(3, "beta", 30), decision(4, {})],
      WINDOW,
    );
    expect(data).toMatchObject({
      total: 4,
      served: 3,
      failed: 1,
      servedByReplica: { alpha: 2, beta: 1 },
    });
  });

  it("uses nearest-rank percentiles, so every figure was actually observed", () => {
    const ds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, i) => served(i, "alpha", ms));
    const { latency } = aggregate(ds, WINDOW);
    expect(latency).toEqual({ sampleSize: 10, p50Ms: 50, p95Ms: 100, p99Ms: 100 });
  });

  it("reports sampleSize, which can be smaller than served", () => {
    const { latency, served: n } = aggregate([served(1, "alpha", 10), served(2, "alpha")], WINDOW);
    expect(n).toBe(2);
    expect(latency?.sampleSize).toBe(1);
  });

  it("gives latency null, not zeros, when no decision has a latency", () => {
    expect(aggregate([decision(1, {}), decision(2, {})], WINDOW).latency).toBeNull();
  });
});

describe("query_decisions: point lookup", () => {
  const recorded = decision(1, { requestId: REQ, chosenReplicaId: "alpha" });

  it("explains a recorded request id found in the question", async () => {
    const { ask } = setup([recorded]);
    const res = await ask(`Why did request ${REQ} go where it did?`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.data as { decision: Decision }).decision).toEqual(recorded);
    expect(res.groundedIn).toMatchObject({ source: "decision_log", recordIds: ["dec-1"] });
  });

  it("matches the id case-insensitively", async () => {
    const { ask } = setup([recorded]);
    expect((await ask(`explain ${REQ.toUpperCase()}`)).ok).toBe(true);
  });

  it("says so for an id that was never recorded", async () => {
    const { ask } = setup([recorded]);
    expect(await ask(`why did ${OTHER} go there`)).toEqual({
      ok: false,
      code: "no_data",
      reason: `no decision recorded for request id "${OTHER}"`,
    });
  });

  it("refuses two ids rather than picking one", async () => {
    const { ask } = setup([recorded]);
    const res = await ask(`compare ${REQ} and ${OTHER}`);
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(res.ok === false && res.reason).toMatch(/^ambiguous question/);
  });

  it("refuses an id together with a range", async () => {
    const { ask } = setup([recorded]);
    const res = await ask(`p99 for ${REQ} in the last 10 minutes`);
    expect(res.ok === false && res.reason).toMatch(/^ambiguous question/);
  });
});

describe("query_decisions: aggregate", () => {
  const log = [served(1, "alpha", 10), served(2, "beta", 20), decision(3, {})];

  it("answers a p99 question with the whole aggregate and the resolved range", async () => {
    const { ask } = setup(log);
    const res = await ask(`What happened to p99 ${IN_RANGE}?`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual({
      range: WINDOW,
      total: 3,
      served: 2,
      failed: 1,
      servedByReplica: { alpha: 1, beta: 1 },
      latency: { sampleSize: 2, p50Ms: 10, p95Ms: 20, p99Ms: 20 },
    });
    expect(res.groundedIn.recordIds).toEqual(["dec-1", "dec-2", "dec-3"]);
  });

  it("handles relative ranges and a trailing question mark", async () => {
    const { ask } = setup([decision(1, { at: "2026-09-29T15:55:00.000Z" })]);
    expect((await ask("how many requests failed in the last 10 minutes?")).ok).toBe(true);
  });

  it("returns ok with latency null when every request in range failed", async () => {
    const { ask } = setup([decision(1, {}), decision(2, {})]);
    const res = await ask(`failures ${IN_RANGE}`);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { latency: unknown }).latency).toBeNull();
  });
});

describe("query_decisions: grounding (O13)", () => {
  it("an empty range is no_data naming the range, never zeros", async () => {
    const { ask } = setup([]);
    expect(await ask(`p99 ${IN_RANGE}`)).toEqual({
      ok: false,
      code: "no_data",
      reason: `no decisions recorded between ${WINDOW.from} and ${WINDOW.to}`,
    });
  });

  it("decisions outside the range do not count", async () => {
    const { ask } = setup([decision(1, { at: "2026-09-29T09:00:00.000Z", latencyMs: 5 })]);
    expect(await ask(`p99 ${IN_RANGE}`)).toMatchObject({ ok: false, code: "no_data" });
  });

  it("never falls back to all time when the range is missing", async () => {
    const { ask } = setup([served(1, "alpha", 10)]);
    const res = await ask("what is the p99?");
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(res.ok === false && res.reason).toMatch(/^unsupported question/);
  });

  it("lists the supported shapes in an unsupported-question reason", async () => {
    const { ask } = setup([]);
    const res = await ask("tell me a joke");
    expect(res.ok === false && res.reason).toMatch(/Supported questions/);
  });

  it("rejects a range with no aggregate word instead of guessing one", async () => {
    const { ask } = setup([served(1, "alpha", 10)]);
    const res = await ask("tell me about the last 10 minutes");
    expect(res.ok === false && res.reason).toMatch(/^unsupported question/);
  });

  it("reports an unreadable range as invalid_input", async () => {
    const { ask } = setup([served(1, "alpha", 10)]);
    const res = await ask("p99 between 25:00 and 26:00");
    expect(res).toMatchObject({ ok: false, code: "invalid_input" });
    expect(res.ok === false && res.reason).toMatch(/^could not read a time range/);
  });

  it("reports an inverted range as invalid_input", async () => {
    const { ask } = setup([served(1, "alpha", 10)]);
    const res = await ask("p99 between 2026-09-29T15:10:00Z and 2026-09-29T15:00:00Z");
    expect(res.ok === false && res.reason).toMatch(/^could not read a time range/);
  });

  it("rejects an empty or missing question", async () => {
    const { ask, call } = setup([]);
    expect(await ask("  ")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await call({} as never)).toMatchObject({ ok: false, code: "invalid_input" });
  });
});
