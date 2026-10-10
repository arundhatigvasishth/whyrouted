/**
 * `query_decisions(natural_language_query)` (O11 + O12, M5a).
 *
 * No LLM inside the tool: a deterministic matcher turns the question into
 * either a point lookup (a request id in the text) or an aggregate over a time
 * range, and the answer is computed only from the `Decision`s the log returns.
 * Anything outside the supported shapes is `invalid_input` listing them, never
 * a guess. Shape and rules fixed by docs/milestones/m5a/shared-contract.md, O4.
 */

import type { Decision, DecisionLog } from "../../decisions/types.js";
import type { ToolHandler } from "../types.js";
import { explainDecision, type ExplainRoutingDecisionData } from "./explain-routing-decision.js";

export interface QueryDecisionsArgs {
  natural_language_query: string;
}

export interface AggregateData {
  /** The range actually queried, after normalization. Always present. */
  range: { from: string; to: string };
  /** Decisions found in range. */
  total: number;
  /** chosenReplicaId !== null / === null. served + failed === total. */
  served: number;
  failed: number;
  /** Served counts by replica id. Only replicas that served >= 1 request. */
  servedByReplica: Record<string, number>;
  /** Over decisions that carry a latency value; null if none do. */
  latency: {
    sampleSize: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } | null;
}

export type QueryDecisionsData = ExplainRoutingDecisionData | AggregateData;

/**
 * Turns a range phrase ("between 3:00 and 3:10", "last 10 minutes") into ISO
 * UTC bounds, or says why it cannot. Supplied by the shared range parser
 * (`src/mcp/time-range.ts`); injected so this tool does not own a second one.
 */
export type RangeResolver = (
  phrase: string,
  now: Date,
) => { from: string; to: string } | { error: string };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const RANGE_PATTERNS = [
  /\bbetween\s+\S+\s+and\s+\S+/i,
  /\bfrom\s+\S+\s+to\s+\S+/i,
  /\blast\s+(?:\d+\s+)?(?:seconds?|minutes?|hours?|days?)\b/i,
  /\blast\s+(?:hour|minute|day)\b/i,
];

const AGGREGATE_WORD = /\b(?:p50|p95|p99|latency|count|how many|failed|failures|per replica)\b/i;

const SUPPORTED =
  'Supported questions: a request id ("why did request <uuid> go where it did"), ' +
  'or an aggregate over a time range using p50, p95, p99, latency, count, how many, failed, failures or per replica ' +
  '("what was p99 between 3:00 and 3:10", "how many requests failed in the last 10 minutes").';

function extractRange(question: string): string | undefined {
  for (const re of RANGE_PATTERNS) {
    const m = re.exec(question);
    if (m !== null) return m[0].replace(/[?.!,;]+$/, "");
  }
  return undefined;
}

/** Nearest-rank percentile of an ascending array: the value at 1-based index ceil(p/100 * n). */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

/** Aggregate a non-empty set of decisions. */
export function aggregate(decisions: Decision[], range: { from: string; to: string }): AggregateData {
  const servedByReplica: Record<string, number> = {};
  const latencies: number[] = [];
  let served = 0;
  for (const d of decisions) {
    if (d.chosenReplicaId !== null) {
      served++;
      servedByReplica[d.chosenReplicaId] = (servedByReplica[d.chosenReplicaId] ?? 0) + 1;
    }
    if (typeof d.latencyMs === "number") latencies.push(d.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  return {
    range,
    total: decisions.length,
    served,
    failed: decisions.length - served,
    servedByReplica,
    latency:
      latencies.length === 0
        ? null
        : {
            sampleSize: latencies.length,
            p50Ms: nearestRank(latencies, 50),
            p95Ms: nearestRank(latencies, 95),
            p99Ms: nearestRank(latencies, 99),
          },
  };
}

export function createQueryDecisions(deps: {
  decisionLog: Pick<DecisionLog, "get" | "query">;
  resolveRange: RangeResolver;
  now?: () => Date;
}): ToolHandler<QueryDecisionsArgs, QueryDecisionsData> {
  const now = deps.now ?? (() => new Date());

  return (args) => {
    const question = args?.natural_language_query;
    if (typeof question !== "string" || question.trim() === "") {
      return { kind: "invalid_input", reason: `natural_language_query must be a non-empty string. ${SUPPORTED}` };
    }

    const ids = [...question.matchAll(UUID)].map((m) => m[0].toLowerCase());
    const phrase = extractRange(question);

    if (ids.length > 1 || (ids.length === 1 && phrase !== undefined)) {
      return {
        kind: "invalid_input",
        reason: "ambiguous question: ask about one request id or one time range, not both or several",
      };
    }

    if (ids.length === 1) {
      const decision = deps.decisionLog.get(ids[0]!);
      if (decision === undefined) {
        return { kind: "no_data", reason: `no decision recorded for request id "${ids[0]}"` };
      }
      return {
        kind: "data",
        data: explainDecision(decision),
        source: "decision_log",
        recordIds: [decision.id],
      };
    }

    if (phrase === undefined || !AGGREGATE_WORD.test(question)) {
      return { kind: "invalid_input", reason: `unsupported question. ${SUPPORTED}` };
    }

    const range = deps.resolveRange(phrase, now());
    if ("error" in range) {
      return { kind: "invalid_input", reason: `could not read a time range from "${phrase}": ${range.error}` };
    }
    if (range.from > range.to) {
      return { kind: "invalid_input", reason: `could not read a time range from "${phrase}": start is after end` };
    }

    const decisions = deps.decisionLog.query({ from: range.from, to: range.to });
    if (decisions.length === 0) {
      return { kind: "no_data", reason: `no decisions recorded between ${range.from} and ${range.to}` };
    }
    return {
      kind: "data",
      data: aggregate(decisions, { from: range.from, to: range.to }),
      source: "decision_log",
      recordIds: decisions.map((d) => d.id),
    };
  };
}
