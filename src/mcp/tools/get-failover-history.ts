/**
 * `get_failover_history` (O8, M5a).
 *
 * The timeline of replica ejections and recoveries in a window, read from the
 * failover log. Arguments and result shape fixed by
 * docs/milestones/m5a/shared-contract.md, "Also agreed":
 *
 *   - `from` / `to`: ISO 8601 bounds, inclusive, either optional.
 *   - `last`: a relative phrase like `"10 minutes"`, for callers that cannot
 *     know the server's clock. Not combinable with `from` or `to`.
 *   - no arguments: the whole log.
 *
 * Bounds are normalized to UTC before they reach `FailoverLog.query`, which
 * compares `at` as strings. The range actually queried is echoed back so a
 * caller can see what a relative phrase resolved to.
 */

import { z } from "zod";
import type { FailoverEvent, FailoverLog } from "../../events/types.js";
import { defineTool, type ReadToolDefinition } from "../server.js";
import { normalizeIso, resolveLast } from "../time-range.js";

export interface FailoverHistoryData {
  /** The bounds actually queried, after normalization. Absent bound means open-ended. */
  range: { from?: string; to?: string };
  /** Ascending by `at`, exactly as the log returns them. */
  events: FailoverEvent[];
}

export interface FailoverHistoryOptions {
  /** Clock for resolving `last`. Defaults to `() => new Date()`. Tests inject one. */
  now?: () => Date;
}

type Bounds = { from?: string; to?: string };

function describe(range: Bounds): string {
  if (range.from !== undefined && range.to !== undefined) {
    return `between ${range.from} and ${range.to}`;
  }
  if (range.from !== undefined) return `since ${range.from}`;
  if (range.to !== undefined) return `up to ${range.to}`;
  return "in the log";
}

export function createGetFailoverHistoryTool(
  log: Pick<FailoverLog, "query">,
  opts: FailoverHistoryOptions = {},
): ReadToolDefinition {
  const now = opts.now ?? (() => new Date());

  return defineTool({
    name: "get_failover_history",
    description:
      "Timeline of replica ejections and recoveries, from the failover log. Give from/to (ISO 8601, inclusive) or last (e.g. '10 minutes'), or neither for the whole log.",
    inputSchema: {
      from: z.string().optional().describe("ISO 8601 start of the window, inclusive"),
      to: z.string().optional().describe("ISO 8601 end of the window, inclusive"),
      last: z
        .string()
        .optional()
        .describe("Relative window ending now, e.g. '10 minutes' or '1 hour'. Not with from/to"),
    },
    handler: ({ from, to, last }) => {
      let range: Bounds;

      if (last !== undefined) {
        if (from !== undefined || to !== undefined) {
          return {
            kind: "invalid_input" as const,
            reason: "give either last, or from and/or to, not both",
          };
        }
        const resolved = resolveLast(last, now());
        if (!resolved.ok) return { kind: "invalid_input" as const, reason: resolved.reason };
        range = resolved.range;
      } else {
        range = {};
        for (const [key, value] of [
          ["from", from],
          ["to", to],
        ] as const) {
          if (value === undefined) continue;
          const iso = normalizeIso(value);
          if (iso === undefined) {
            return {
              kind: "invalid_input" as const,
              reason: `${key} "${value}" is not an ISO 8601 timestamp`,
            };
          }
          range[key] = iso;
        }
        if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
          return { kind: "invalid_input" as const, reason: "from is after to" };
        }
      }

      const events = log.query(range);
      if (events.length === 0) {
        return {
          kind: "no_data" as const,
          reason: `no failover events recorded ${describe(range)}`,
        };
      }
      const data: FailoverHistoryData = { range, events };
      return {
        kind: "data" as const,
        data,
        source: "failover_log" as const,
        recordIds: events.map((e) => e.id),
      };
    },
  });
}
