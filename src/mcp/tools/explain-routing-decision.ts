/**
 * `explain_routing_decision(request_id)` (O10, M5a).
 *
 * Looks up the recorded `Decision` for a request and returns it verbatim plus
 * a short, deterministic, cited explanation. No LLM is involved: every id,
 * number, and reason in a line's text is interpolated from the value at one
 * of the line's `cites` paths, so a test (and the calling client) can check
 * each claim against the record. Shape and rules fixed by
 * docs/milestones/m5a/shared-contract.md, O3.
 *
 * The lines state what was recorded and nothing else. A candidate that is in
 * neither `candidates` nor `excluded` (latency-weighted skips ones with no
 * latency measurement, N1) gets no sentence: the record does not say why.
 */

import type { Decision, DecisionLog, DecisionRound } from "../../decisions/types.js";
import type { ToolHandler } from "../types.js";

export interface ExplainRoutingDecisionArgs {
  request_id: string;
}

export interface ExplanationLine {
  /** One plain sentence, built only from the values at `cites`. */
  text: string;
  /** Paths into `decision` that back the sentence, e.g. "rounds[0].candidates[1].score". Non-empty. */
  cites: string[];
}

export interface ExplainRoutingDecisionData {
  /** The recorded Decision, verbatim. `lines` is derived from it. */
  decision: Decision;
  /** Overview first, then one entry per round in attempt order. */
  lines: ExplanationLine[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Resolve a cite path like `rounds[0].candidates[1].score` against a Decision. */
export function resolveCite(decision: Decision, path: string): unknown {
  let cur: unknown = decision;
  for (const part of path.split(".")) {
    const m = /^([A-Za-z_]\w*)(?:\[(\d+)\])?$/.exec(part);
    if (m === null || typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]!];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    }
  }
  return cur;
}

function overview(decision: Decision): ExplanationLine {
  const n = decision.rounds.length;
  if (n === 0) {
    return { text: "The record contains no rounds.", cites: ["rounds"] };
  }
  if (decision.chosenReplicaId !== null) {
    return {
      text: `Served by ${decision.chosenReplicaId} after ${plural(n, "round")}.`,
      cites: ["chosenReplicaId", "rounds"],
    };
  }
  return {
    text: `No replica returned a usable response, after ${plural(n, "round")}.`,
    cites: ["chosenReplicaId", "rounds"],
  };
}

function roundLine(round: DecisionRound, i: number): ExplanationLine {
  const base = `rounds[${i}]`;
  const label = `Round ${i + 1}`;

  if (round.outcome === "no_healthy_replicas") {
    // `strategy` on this round is the configured name, not one that scored
    // anything (N4), so it is left out of the sentence on purpose.
    const cites = [`${base}.outcome`];
    let text = `${label}: the registry had no healthy replica.`;
    const ex = excludedPart(round, base);
    text += ex.text;
    cites.push(...ex.cites);
    return { text, cites };
  }

  const cites = [`${base}.strategy`, `${base}.outcome`];
  let text: string;

  if (round.outcome === "no_routable_replica") {
    text = `${label} (${round.strategy}): no replica could be picked; ${plural(round.candidates.length, "candidate")} scored.`;
    cites.push(`${base}.candidates`);
  } else {
    const picked = round.pickedReplicaId;
    cites.push(`${base}.pickedReplicaId`);
    const ranked = round.candidates
      .map((c, j) => ({ c, j }))
      .sort((a, b) => a.c.score - b.c.score || a.j - b.j);
    const rotation = round.strategy === "round-robin";
    const scoreWord = rotation ? "rotation position" : "score";
    const detail = ({ c, j }: (typeof ranked)[number]): string => {
      cites.push(`${base}.candidates[${j}].score`);
      return `${scoreWord} ${c.score}`;
    };
    const describe = (e: (typeof ranked)[number]): string => {
      cites.push(`${base}.candidates[${e.j}].replicaId`);
      return `${e.c.replicaId} (${detail(e)})`;
    };
    const winner = ranked.find(({ c }) => c.replicaId === picked);
    const others = ranked.filter((r) => r !== winner);
    text = `${label} (${round.strategy}): picked ${picked}`;
    if (winner !== undefined) text += ` (${detail(winner)})`;
    if (others.length > 0) {
      text += `${rotation ? ", then in rotation:" : " over"} ${others.map(describe).join(", ")}`;
    }
    text += ".";
  }

  const ex = excludedPart(round, base);
  text += ex.text;
  cites.push(...ex.cites);

  if (round.failureReason !== undefined) {
    const f = round.failureReason;
    text += ` It then failed with ${f.kind}${f.status !== undefined ? ` ${f.status}` : ""}.`;
    cites.push(`${base}.failureReason.kind`);
    if (f.status !== undefined) cites.push(`${base}.failureReason.status`);
  }
  return { text, cites };
}

function excludedPart(round: DecisionRound, base: string): { text: string; cites: string[] } {
  if (round.excluded.length === 0) return { text: "", cites: [] };
  const cites: string[] = [];
  const items = round.excluded.map((e, k) => {
    cites.push(`${base}.excluded[${k}].replicaId`, `${base}.excluded[${k}].reason`);
    return `${e.replicaId} (${e.reason})`;
  });
  return { text: ` Excluded: ${items.join(", ")}.`, cites };
}

/** Build the cited explanation for one recorded Decision. */
export function explainDecision(decision: Decision): ExplainRoutingDecisionData {
  return {
    decision,
    lines: [overview(decision), ...decision.rounds.map(roundLine)],
  };
}

export function createExplainRoutingDecision(deps: {
  decisionLog: Pick<DecisionLog, "get">;
}): ToolHandler<ExplainRoutingDecisionArgs, ExplainRoutingDecisionData> {
  return (args) => {
    const requestId = args?.request_id;
    if (typeof requestId !== "string" || requestId.trim() === "") {
      return { kind: "invalid_input", reason: "request_id must be a non-empty string" };
    }
    const decision = deps.decisionLog.get(requestId);
    if (decision === undefined) {
      return { kind: "no_data", reason: `no decision recorded for request id "${requestId}"` };
    }
    return {
      kind: "data",
      data: explainDecision(decision),
      source: "decision_log",
      recordIds: [decision.id],
    };
  };
}
