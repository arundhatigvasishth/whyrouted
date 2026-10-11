import { describe, expect, it } from "vitest";
import { performAction, type ActionOutput } from "../src/mcp/action.js";

const fixedNow = () => new Date("2026-10-11T12:00:00.000Z");

describe("performAction", () => {
  it("wraps an applied change, stamping appliedAt itself and deriving changed", async () => {
    const act = performAction<{ to: string }, { strategy: string }>(
      ({ to }) => ({
        kind: "applied",
        before: { strategy: "least-loaded" },
        after: { strategy: to },
      }),
      { now: fixedNow },
    );
    expect(await act({ to: "round-robin" })).toEqual({
      ok: true,
      changed: true,
      before: { strategy: "least-loaded" },
      after: { strategy: "round-robin" },
      appliedAt: "2026-10-11T12:00:00.000Z",
    });
  });

  it("reports changed: false, as a success, when before and after are equal", async () => {
    const act = performAction<void, { strategy: string }>(
      () => ({
        kind: "applied",
        before: { strategy: "least-loaded" },
        after: { strategy: "least-loaded" },
      }),
      { now: fixedNow },
    );
    const res = await act();
    expect(res.ok).toBe(true);
    expect(res.ok && res.changed).toBe(false);
  });

  it("derives changed from the data, so a handler cannot claim a change that did not happen", async () => {
    // Key order differs but the values are equal: still not a change.
    const act = performAction<void, { a: number; b: number }>(() => ({
      kind: "applied",
      before: { a: 1, b: 2 },
      after: { b: 2, a: 1 },
    }));
    const res = await act();
    expect(res.ok && res.changed).toBe(false);
  });

  it("detects a change in a nested value", async () => {
    const act = performAction<void, { state: { killed: boolean } }>(() => ({
      kind: "applied",
      before: { state: { killed: false } },
      after: { state: { killed: true } },
    }));
    const res = await act();
    expect(res.ok && res.changed).toBe(true);
  });

  it("gives changed: null, and no before key, when the handler has no before", async () => {
    const act = performAction<void, { killed: boolean }>(
      () => ({ kind: "applied", after: { killed: true } }),
      { now: fixedNow },
    );
    const res = await act();
    expect(res).toEqual({
      ok: true,
      changed: null,
      after: { killed: true },
      appliedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(res.ok && "before" in res).toBe(false);
  });

  it("passes notes through, and leaves the key off when there are none", async () => {
    const withNotes = performAction<void, number>(() => ({
      kind: "applied",
      before: 1,
      after: 2,
      notes: ["weights are stored but not used by this strategy"],
    }));
    const a = await withNotes();
    expect(a.ok && a.notes).toEqual(["weights are stored but not used by this strategy"]);

    const empty = performAction<void, number>(() => ({
      kind: "applied",
      before: 1,
      after: 2,
      notes: [],
    }));
    const b = await empty();
    expect(b.ok && "notes" in b).toBe(false);
  });

  it("maps each failure kind straight through with the handler's reason", async () => {
    for (const kind of ["unknown_replica", "invalid_input", "unsupported"] as const) {
      const act = performAction<void, never>(() => ({ kind, reason: `because ${kind}` }));
      expect(await act()).toEqual({ ok: false, code: kind, reason: `because ${kind}` });
    }
  });

  it("accepts an async handler", async () => {
    const act = performAction<void, number>(async () => ({ kind: "applied", before: 1, after: 2 }));
    expect((await act()).ok).toBe(true);
  });

  it("turns a sync throw into internal_error instead of rejecting", async () => {
    const act = performAction<void, never>(() => {
      throw new Error("boom");
    });
    expect(await act()).toEqual({ ok: false, code: "internal_error", reason: "boom" });
  });

  it("turns an async rejection, including a non-Error, into internal_error", async () => {
    const act = performAction<void, never>(async () => {
      throw "plain string";
    });
    expect(await act()).toEqual({ ok: false, code: "internal_error", reason: "plain string" });
  });

  it("passes the handler's args through", async () => {
    const act = performAction<{ id: string }, string>(({ id }) => ({
      kind: "applied",
      before: "old",
      after: id,
    }));
    const res = await act({ id: "replica-1" });
    expect(res.ok && res.after).toBe("replica-1");
  });

  it("does not let a later change to a handler's notes array alter the result", async () => {
    const notes = ["a"];
    const out: ActionOutput<number> = { kind: "applied", before: 1, after: 2, notes };
    const res = await performAction<void, number>(() => out)();
    notes.push("b");
    expect(res.ok && res.notes).toEqual(["a"]);
  });
});
