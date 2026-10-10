/**
 * Shared time-range parser (M5a, docs/milestones/m5a/shared-contract.md,
 * "Also agreed" and O4).
 *
 * Turns the range phrases MCP callers write into `{ from, to }` ISO 8601 UTC
 * strings, which is what `FailoverLog.query` and `DecisionLog.query` compare
 * against (both compare `at` as strings, so a bound with a UTC offset or
 * without milliseconds would silently miss records). Used by
 * `get_failover_history` for its `last` argument and by `query_decisions` to
 * pull a range out of a question.
 *
 * Recognized forms:
 *   - relative to now:   `last 10 minutes`, `last hour`, `2 days`
 *   - explicit ISO pair: `between <iso> and <iso>`, `from <iso> to <iso>`
 *   - clock-time pair:   `between 3:00 and 3:10`, `from 15:00 to 15:10`
 *
 * Clock times and ISO timestamps with no zone are read as the server's local
 * time (the clock-time ones on today's date). That is a guess, so callers
 * echo the resolved range back. A clock time without seconds covers its whole
 * minute when it is the end of the range, so `between 3:00 and 3:10` includes
 * a decision recorded at 3:10:42.
 */

export interface ResolvedRange {
  from: string;
  to: string;
}

export type RangeResult = { ok: true; range: ResolvedRange } | { ok: false; reason: string };

/** What `findRange` saw in a piece of free text. */
export type RangeSearch =
  | { kind: "none" }
  | { kind: "range"; range: ResolvedRange; matched: string }
  | { kind: "invalid"; reason: string };

const UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
};

const MAX_RELATIVE_DAYS = 30;

const ISO_TS = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?`;
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?`;

const RELATIVE_RE = /\b(?:last|past|previous)\s+(\d+\s*)?([a-z]+?)s?\b/i;
const ISO_PAIR_RE = new RegExp(
  String.raw`\b(?:between|from)\s+(${ISO_TS})\s+(?:and|to)\s+(${ISO_TS})`,
  "i",
);
const CLOCK_PAIR_RE = new RegExp(
  String.raw`\b(?:between|from)\s+(${CLOCK})\s+(?:and|to)\s+(${CLOCK})`,
  "i",
);

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function unitMs(raw: string): number | undefined {
  return UNIT_MS[raw.toLowerCase()];
}

/**
 * Resolve a relative phrase against `now`. Accepts the `last` argument of
 * `get_failover_history` (`"10 minutes"`, `"1 hour"`, `"hour"`) as well as the
 * full `"last 10 minutes"`.
 */
export function resolveLast(phrase: string, now: Date): RangeResult {
  const text = phrase.trim();
  const m = /^(?:(?:last|past|previous)\s+)?(\d+\s*)?([a-z]+?)s?$/i.exec(text);
  const ms = m?.[2] === undefined ? undefined : unitMs(m[2]);
  if (m === null || ms === undefined) {
    return fail(
      `could not read a time range from "${phrase}": expected something like "10 minutes" or "1 hour"`,
    );
  }
  const count = m[1] === undefined ? 1 : Number(m[1].trim());
  if (count < 1)
    return fail(`could not read a time range from "${phrase}": the count must be at least 1`);
  const span = count * ms;
  if (span > MAX_RELATIVE_DAYS * UNIT_MS.day!) {
    return fail(
      `could not read a time range from "${phrase}": at most ${MAX_RELATIVE_DAYS} days back`,
    );
  }
  return {
    ok: true,
    range: { from: new Date(now.getTime() - span).toISOString(), to: now.toISOString() },
  };
}

/** Parse one ISO 8601 timestamp to epoch ms, or `undefined` if it is not a real instant. */
function isoMs(text: string): number | undefined {
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * One clock time on `now`'s local date. `endOfMinute` widens a time without
 * seconds to the last millisecond of that minute (used for the end of a range).
 */
function clockMs(text: string, now: Date, endOfMinute: boolean): number | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])m)?$/i.exec(text.trim());
  if (m === null) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? undefined : Number(m[3]);
  const meridiem = m[4]?.toLowerCase();
  if (minute > 59 || (second !== undefined && second > 59)) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }
  const d = new Date(now);
  d.setHours(
    hour,
    minute,
    second ?? (endOfMinute ? 59 : 0),
    second === undefined && endOfMinute ? 999 : 0,
  );
  return d.getTime();
}

function ordered(fromMs: number | undefined, toMs: number | undefined, label: string): RangeResult {
  if (fromMs === undefined || toMs === undefined) {
    return fail(`could not read a time range from "${label}": not a valid time`);
  }
  if (fromMs > toMs)
    return fail(`could not read a time range from "${label}": the start is after the end`);
  return {
    ok: true,
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  };
}

/**
 * Look for a range phrase inside free text. `none` means nothing range-shaped
 * was there (the caller decides what that means), `invalid` means a range was
 * written but cannot be honored (inverted, or not a real time), `range` is the
 * resolved result plus the text it came from.
 */
export function findRange(text: string, now: Date): RangeSearch {
  const iso = ISO_PAIR_RE.exec(text);
  if (iso !== null) {
    const r = ordered(isoMs(iso[1]!), isoMs(iso[2]!), iso[0]);
    return r.ok
      ? { kind: "range", range: r.range, matched: iso[0] }
      : { kind: "invalid", reason: r.reason };
  }

  const clock = CLOCK_PAIR_RE.exec(text);
  if (clock !== null) {
    const r = ordered(clockMs(clock[1]!, now, false), clockMs(clock[2]!, now, true), clock[0]);
    return r.ok
      ? { kind: "range", range: r.range, matched: clock[0] }
      : { kind: "invalid", reason: r.reason };
  }

  const rel = RELATIVE_RE.exec(text);
  if (rel !== null && unitMs(rel[2]!) !== undefined) {
    const r = resolveLast(rel[0], now);
    return r.ok
      ? { kind: "range", range: r.range, matched: rel[0] }
      : { kind: "invalid", reason: r.reason };
  }

  return { kind: "none" };
}

/** Normalize one ISO 8601 bound to the UTC form the logs compare against. */
export function normalizeIso(text: string): string | undefined {
  const ms = isoMs(text.trim());
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
