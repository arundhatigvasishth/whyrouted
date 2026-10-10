import { describe, expect, it } from "vitest";
import { createFailoverLog } from "../src/events/failover-log.js";
import type { FailoverEvent } from "../src/events/types.js";
import {
  createGetFailoverHistoryTool,
  type FailoverHistoryData,
} from "../src/mcp/tools/get-failover-history.js";

const now = new Date("2026-10-10T12:00:00.000Z");

function event(id: string, at: string, over: Partial<FailoverEvent> = {}): FailoverEvent {
  return {
    id,
    replicaId: "replica-1",
    kind: "ejected",
    at,
    trigger: "health_check",
    reason: "3 consecutive failed probes",
    ...over,
  };
}

function seeded() {
  const log = createFailoverLog({ unhealthyThreshold: 3, healthyThreshold: 2 });
  log.record(event("e1", "2026-10-10T11:00:00.000Z"));
  log.record(event("e2", "2026-10-10T11:30:00.000Z", { kind: "recovered" }));
  log.record(
    event("e3", "2026-10-10T11:55:00.000Z", {
      replicaId: "replica-2",
      trigger: "request_failure",
      requestId: "req-9",
    }),
  );
  return log;
}

const tool = (log = seeded()) => createGetFailoverHistoryTool(log, { now: () => now });

function ids(res: Awaited<ReturnType<ReturnType<typeof tool>["call"]>>): string[] {
  expect(res.ok).toBe(true);
  return res.ok ? (res.data as FailoverHistoryData).events.map((e) => e.id) : [];
}

describe("get_failover_history", () => {
  it("is named for the MCP client and takes from, to, and last", () => {
    const t = tool();
    expect(t.name).toBe("get_failover_history");
    expect(Object.keys(t.inputSchema).sort()).toEqual(["from", "last", "to"]);
  });

  it("returns the whole log, ascending, when given no arguments", async () => {
    const res = await tool().call({});
    expect(ids(res)).toEqual(["e1", "e2", "e3"]);
    if (res.ok) {
      expect(res.groundedIn.source).toBe("failover_log");
      expect(res.groundedIn.recordIds).toEqual(["e1", "e2", "e3"]);
      expect((res.data as FailoverHistoryData).range).toEqual({});
    }
  });

  it("keeps every field of each event", async () => {
    const res = await tool().call({});
    expect(res.ok && (res.data as FailoverHistoryData).events[2]).toEqual({
      id: "e3",
      replicaId: "replica-2",
      kind: "ejected",
      at: "2026-10-10T11:55:00.000Z",
      trigger: "request_failure",
      reason: "3 consecutive failed probes",
      requestId: "req-9",
    });
  });

  it("filters by an inclusive from/to window", async () => {
    const res = await tool().call({
      from: "2026-10-10T11:30:00.000Z",
      to: "2026-10-10T11:55:00.000Z",
    });
    expect(ids(res)).toEqual(["e2", "e3"]);
  });

  it("accepts a from-only and a to-only bound", async () => {
    expect(ids(await tool().call({ from: "2026-10-10T11:30:00.000Z" }))).toEqual(["e2", "e3"]);
    expect(ids(await tool().call({ to: "2026-10-10T11:00:00.000Z" }))).toEqual(["e1"]);
  });

  it("normalizes a bound with a UTC offset before querying", async () => {
    // 07:30-04:00 is 11:30Z. Compared as raw strings it would match nothing.
    const res = await tool().call({ from: "2026-10-10T07:30:00-04:00" });
    expect(ids(res)).toEqual(["e2", "e3"]);
    expect(res.ok && (res.data as FailoverHistoryData).range.from).toBe("2026-10-10T11:30:00.000Z");
  });

  it("resolves last against the clock and echoes the range it used", async () => {
    const res = await tool().call({ last: "10 minutes" });
    expect(ids(res)).toEqual(["e3"]);
    expect(res.ok && (res.data as FailoverHistoryData).range).toEqual({
      from: "2026-10-10T11:50:00.000Z",
      to: "2026-10-10T12:00:00.000Z",
    });
  });

  it("says so for an empty log", async () => {
    const empty = createFailoverLog({ unhealthyThreshold: 3, healthyThreshold: 2 });
    expect(await tool(empty).call({})).toEqual({
      ok: false,
      code: "no_data",
      reason: "no failover events recorded in the log",
    });
  });

  it("says so for a window with no events, naming the window", async () => {
    const res = await tool().call({
      from: "2026-10-10T09:00:00.000Z",
      to: "2026-10-10T10:00:00.000Z",
    });
    expect(res).toEqual({
      ok: false,
      code: "no_data",
      reason:
        "no failover events recorded between 2026-10-10T09:00:00.000Z and 2026-10-10T10:00:00.000Z",
    });
  });

  it("says so for a window entirely outside the log's history", async () => {
    const future = await tool().call({ from: "2027-01-01T00:00:00.000Z" });
    expect(future).toMatchObject({ ok: false, code: "no_data" });
    const recent = await tool().call({ last: "1 second" });
    expect(recent).toMatchObject({ ok: false, code: "no_data" });
  });

  it("rejects last combined with from or to", async () => {
    for (const args of [
      { last: "1 hour", from: "2026-10-10T11:00:00Z" },
      { last: "1 hour", to: "2026-10-10T11:00:00Z" },
    ]) {
      expect(await tool().call(args)).toEqual({
        ok: false,
        code: "invalid_input",
        reason: "give either last, or from and/or to, not both",
      });
    }
  });

  it("rejects a bound that is not a timestamp, and from after to", async () => {
    expect(await tool().call({ from: "yesterday" })).toMatchObject({
      ok: false,
      code: "invalid_input",
      reason: 'from "yesterday" is not an ISO 8601 timestamp',
    });
    expect(await tool().call({ from: "2026-10-10T11:55:00Z", to: "2026-10-10T11:00:00Z" })).toEqual(
      { ok: false, code: "invalid_input", reason: "from is after to" },
    );
  });

  it("rejects a last phrase it cannot read, never falling back to the whole log", async () => {
    expect(await tool().call({ last: "a while" })).toMatchObject({
      ok: false,
      code: "invalid_input",
      reason: expect.stringMatching(/could not read a time range/),
    });
  });
});
