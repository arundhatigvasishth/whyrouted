import { describe, expect, it } from "vitest";
import { findRange, normalizeIso, resolveLast } from "../src/mcp/time-range.js";

// A local-time "now" so clock-time cases do not depend on the machine's zone.
const now = new Date(2026, 9, 10, 15, 30, 0, 0);
const at = (h: number, m: number, s = 0, ms = 0) =>
  new Date(2026, 9, 10, h, m, s, ms).toISOString();

describe("resolveLast", () => {
  it("resolves a count and a unit back from now", () => {
    expect(resolveLast("10 minutes", now)).toEqual({
      ok: true,
      range: { from: at(15, 20), to: now.toISOString() },
    });
  });

  it("accepts the full phrase and singular, short, and bare units", () => {
    for (const phrase of ["last 10 minutes", "10 min", "last 10 mins", "Last 10 Minutes"]) {
      const r = resolveLast(phrase, now);
      expect(r.ok && r.range.from).toBe(at(15, 20));
    }
    expect(resolveLast("hour", now)).toMatchObject({ ok: true, range: { from: at(14, 30) } });
    expect(resolveLast("last hour", now)).toMatchObject({ ok: true, range: { from: at(14, 30) } });
    expect(resolveLast("2 hrs", now)).toMatchObject({ ok: true, range: { from: at(13, 30) } });
    expect(resolveLast("30 seconds", now)).toMatchObject({
      ok: true,
      range: { from: at(15, 29, 30) },
    });
  });

  it("rejects an unknown unit, a zero count, and a window past 30 days", () => {
    for (const phrase of ["10 parsecs", "banana", "0 minutes", "31 days", ""]) {
      const r = resolveLast(phrase, now);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/could not read a time range/);
    }
    expect(resolveLast("30 days", now).ok).toBe(true);
  });
});

describe("findRange", () => {
  it("finds a clock-time pair and covers the whole end minute", () => {
    const r = findRange("what happened to p99 between 3:00 and 3:10?", now);
    expect(r).toMatchObject({
      kind: "range",
      matched: "between 3:00 and 3:10",
      range: { from: at(3, 0), to: at(3, 10, 59, 999) },
    });
  });

  it("reads 24-hour times, am/pm, and from/to", () => {
    expect(findRange("from 15:00 to 15:10", now)).toMatchObject({
      range: { from: at(15, 0), to: at(15, 10, 59, 999) },
    });
    expect(findRange("between 3:00 pm and 3:10 pm", now)).toMatchObject({
      range: { from: at(15, 0), to: at(15, 10, 59, 999) },
    });
    expect(findRange("between 12:00 am and 12:30 pm", now)).toMatchObject({
      range: { from: at(0, 0), to: at(12, 30, 59, 999) },
    });
  });

  it("keeps explicit seconds exact", () => {
    expect(findRange("between 3:00:00 and 3:10:30", now)).toMatchObject({
      range: { from: at(3, 0), to: at(3, 10, 30) },
    });
  });

  it("finds an explicit ISO pair and normalizes to UTC", () => {
    const r = findRange(
      "failures between 2026-10-10T08:00:00-04:00 and 2026-10-10T08:10:00-04:00",
      now,
    );
    expect(r).toMatchObject({
      kind: "range",
      range: { from: "2026-10-10T12:00:00.000Z", to: "2026-10-10T12:10:00.000Z" },
    });
  });

  it("finds a relative phrase inside a sentence", () => {
    expect(findRange("how many requests failed in the last 10 minutes?", now)).toMatchObject({
      kind: "range",
      matched: "last 10 minutes",
      range: { from: at(15, 20), to: now.toISOString() },
    });
    expect(findRange("p95 over the last hour", now)).toMatchObject({
      range: { from: at(14, 30) },
    });
  });

  it("flags an inverted range and an impossible time instead of guessing", () => {
    expect(findRange("between 3:10 and 3:00", now)).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/start is after the end/),
    });
    expect(findRange("between 25:00 and 26:00", now)).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/not a valid time/),
    });
    expect(findRange("between 3:99 and 4:00", now)).toMatchObject({ kind: "invalid" });
    expect(findRange("between 13:00 pm and 14:00 pm", now)).toMatchObject({ kind: "invalid" });
  });

  it("reports none when nothing range-shaped is present, never all time", () => {
    expect(findRange("why was request abc routed there", now)).toEqual({ kind: "none" });
    expect(findRange("what is the last thing", now)).toEqual({ kind: "none" });
    expect(findRange("", now)).toEqual({ kind: "none" });
  });
});

describe("normalizeIso", () => {
  it("converts an offset timestamp to the UTC form the logs compare against", () => {
    expect(normalizeIso("2026-10-10T08:00:00-04:00")).toBe("2026-10-10T12:00:00.000Z");
    expect(normalizeIso("2026-10-10T12:00:00Z")).toBe("2026-10-10T12:00:00.000Z");
  });

  it("returns undefined for something that is not a timestamp", () => {
    expect(normalizeIso("yesterday")).toBeUndefined();
    expect(normalizeIso("")).toBeUndefined();
  });
});
