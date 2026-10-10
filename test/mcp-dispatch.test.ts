import { describe, expect, it } from "vitest";
import { dispatch, type ToolOutput } from "../src/mcp/types.js";

const fixedNow = () => new Date("2026-09-29T12:00:00.000Z");

describe("dispatch", () => {
  it("wraps data with grounding, stamping queriedAt itself", async () => {
    const call = dispatch<{ id: string }, { n: number }>(
      () => ({ kind: "data", data: { n: 3 }, source: "decision_log", recordIds: ["d1", "d2"] }),
      { now: fixedNow },
    );
    expect(await call({ id: "x" })).toEqual({
      ok: true,
      data: { n: 3 },
      groundedIn: {
        source: "decision_log",
        queriedAt: "2026-09-29T12:00:00.000Z",
        recordIds: ["d1", "d2"],
      },
    });
  });

  it("passes the handler's args through", async () => {
    const call = dispatch<{ id: string }, string>((a) => ({
      kind: "data",
      data: a.id,
      source: "registry",
      recordIds: [a.id],
    }));
    const res = await call({ id: "r1" });
    expect(res.ok && res.data).toBe("r1");
  });

  it("turns data with zero record ids into no_data, never an empty ok", async () => {
    const call = dispatch<void, { total: number }>(() => ({
      kind: "data",
      data: { total: 0 },
      source: "failover_log",
      recordIds: [],
    }));
    expect(await call()).toEqual({
      ok: false,
      code: "no_data",
      reason: "no records found in failover_log",
    });
  });

  it("passes no_data and invalid_input through with the handler's reason", async () => {
    const noData = dispatch<void, never>(() => ({ kind: "no_data", reason: "nothing in range" }));
    const bad = dispatch<void, never>(() => ({ kind: "invalid_input", reason: "from after to" }));
    expect(await noData()).toEqual({ ok: false, code: "no_data", reason: "nothing in range" });
    expect(await bad()).toEqual({ ok: false, code: "invalid_input", reason: "from after to" });
  });

  it("accepts an async handler", async () => {
    const call = dispatch<void, number>(async () => ({
      kind: "data",
      data: 1,
      source: "registry",
      recordIds: ["r1"],
    }));
    expect((await call()).ok).toBe(true);
  });

  it("turns a sync throw into internal_error instead of rejecting", async () => {
    const call = dispatch<void, never>(() => {
      throw new Error("boom");
    });
    expect(await call()).toEqual({ ok: false, code: "internal_error", reason: "boom" });
  });

  it("turns an async rejection, including a non-Error, into internal_error", async () => {
    const call = dispatch<void, never>(async () => {
      throw "plain string";
    });
    expect(await call()).toEqual({ ok: false, code: "internal_error", reason: "plain string" });
  });

  it("copies recordIds so a handler mutating its array later cannot change the result", async () => {
    const ids = ["d1"];
    const out: ToolOutput<number> = {
      kind: "data",
      data: 1,
      source: "decision_log",
      recordIds: ids,
    };
    const res = await dispatch<void, number>(() => out)();
    ids.push("d2");
    expect(res.ok && res.groundedIn.recordIds).toEqual(["d1"]);
  });
});
