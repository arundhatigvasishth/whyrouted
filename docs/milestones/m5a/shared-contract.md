# M5a Shared Contract (O1 to O4)

**Status:** DRAFT. O3 and O4 drafted by Arundhati; O1 and O2 are Junaid's to
draft and are stubbed below. Nothing here is agreed until Junaid reviews O3/O4
and Arundhati reviews O1/O2, and the sign-off checklist at the bottom is
checked. O5 through O14 build against this doc once it is.
**Covers:** the MCP server process shape (O1), the tool response envelope
(O2), `explain_routing_decision`'s output shape (O3), and how
`query_decisions` turns a question into a grounded answer (O4).

Landed / to land as:
- O1: `docs/decisions.md` entry (Junaid)
- O2: `src/mcp/types.ts` (`ToolResult`, designed by Junaid, built by Arundhati)
- O3: `src/mcp/tools/explain-routing-decision.ts` (signature only here)
- O4: `src/mcp/tools/query-decisions.ts` (signature only here), plus one
  additive change to `src/decisions/types.ts` (see O4, "The latency gap")

Any change after sign-off goes through a PR that updates this doc and the
affected files together.

---

## O1: MCP server process shape

*Junaid drafts. Leading answer from the task split: in-process, same Node
process as the API server, direct references to the existing store
instances, no Redis. Not restated here so it isn't decided by whoever wrote
the stub.*

## O2: Tool response envelope

*Junaid drafts the shape; Arundhati builds it (O6).*

Assumed below, and needed from O2 as written: every tool returns
`ToolResult<T>`, an `ok: true` arm carrying `data: T` and a `groundedIn`
marker, and an `ok: false` arm carrying a `reason: string`. O3 and O4 define
only the `T` for their tools and their `ok: false` reasons. If O2 lands with a
different shape, O3/O4's `data` types still hold; only the wrapper changes.

---

## O3: `explain_routing_decision` output shape

**File:** `src/mcp/tools/explain-routing-decision.ts`

### The call

PRD §5.6 says "grounded, cited explanation" and doesn't say where prose gets
written. Three options were on the table:

1. The tool returns prose it generated, citing fields inline.
2. The tool returns the raw `Decision` and lets the MCP client's model write
   all the prose.
3. The tool returns the raw `Decision` **plus** a short deterministic summary
   where every claim carries a pointer back to the field it came from.

**Proposed: (3).** No LLM call inside the tool.

- **Why not (1):** it needs an LLM inside the router, which PRD §7 lists no
  dependency for, and it makes PRD §8's "100% of answers grounded in
  decision-log values" impossible to test mechanically. You can't assert that
  free LLM prose contains no fabricated figure.
- **Why not (2):** correct but weak. The client model would see the full
  `Decision` and could say anything about it. "Cited" in the PRD would mean
  nothing the server itself guarantees.
- **Why (3):** the summary is template-generated, so a test can check that
  every id and number in it appears at the cited path in the `Decision`.
  The client's model is still free to rephrase for the human, and it has the
  full record to check the summary against.

### Shape

```ts
// src/mcp/tools/explain-routing-decision.ts
import type { Decision } from "../../decisions/types.js";

export interface ExplainRoutingDecisionArgs {
  request_id: string;
}

export interface ExplanationLine {
  /** One plain sentence. Every id, number, and reason in it is interpolated
   *  from the value at one of `cites`, never written by hand. */
  text: string;
  /** Paths into `decision` that back the sentence, e.g.
   *  "rounds[0].candidates[1].score". Non-empty. */
  cites: string[];
}

export interface ExplainRoutingDecisionData {
  /** The recorded Decision, verbatim. The single source of truth: `lines`
   *  is derived from it and adds nothing it doesn't contain. */
  decision: Decision;
  /** Overview first, then one entry per round in attempt order. */
  lines: ExplanationLine[];
}
```

`ToolResult<ExplainRoutingDecisionData>` is the return type.

### Rules

- **Lookup is `DecisionLog.get(request_id)`, exact match only.** No prefix
  match, no "closest request id." An unknown id returns `ok: false` with a
  reason of the form `no decision recorded for request id "<id>"`.
- **The `ok: false` reason does not claim the request never happened.** The
  log is in-memory (M4, "Not frozen"), so a restart empties it. The reason
  says "no decision recorded," which is true in both cases, and does not say
  "no such request."
- **Line order:** one overview line (served or failed, and by which replica
  if served), then one line per round in `rounds` order, so a retried
  request's whole story surfaces, not just the winning round. A failed round
  line includes its `failureReason` (`kind`, and `status` if present).
- **Each round line states what was recorded and nothing else:** strategy,
  the picked replica and its score, how many candidates were scored, and
  each `excluded` entry with its reason. Candidates are listed lowest score
  first (lower wins, per M4's N1 convention).
- **Scores are only compared within one round.** Round-robin's `score` is a
  cyclic distance from the cursor (N1's stand-in), not a load or latency
  figure. The template for a round-robin round says "next in rotation,"
  not "lowest load." Templates are per strategy for this reason.
- **Absence is not explained.** Latency-weighted silently omits null-latency
  candidates (N1, narrowed in M4). A candidate missing from both `candidates`
  and `excluded` gets no sentence at all. The tool never says "replica X was
  skipped because its latency was unknown," since the record doesn't say so.
- **No rounds is not possible for a recorded Decision** (the API layer pushes
  a round before every `record()` call), so no special case. If a Decision
  with `rounds: []` ever does appear, the overview line says the record
  contains no rounds and nothing more.

### Example

For a request retried once (replica `r2` failed, `r1` served it):

```
lines[0].text  "Served by r1 after 2 rounds."
               cites: ["chosenReplicaId", "rounds"]
lines[1].text  "Round 1 (least-loaded): picked r2 (score 0) over r1 (score 3);
                r2 then failed with http_status 500."
               cites: ["rounds[0].strategy", "rounds[0].pickedReplicaId",
                       "rounds[0].candidates[0].score",
                       "rounds[0].candidates[1].score",
                       "rounds[0].failureReason"]
lines[2].text  "Round 2 (least-loaded): r2 excluded (already_tried);
                picked r1 (score 3)."
               cites: ["rounds[1].strategy", "rounds[1].excluded[0]",
                       "rounds[1].pickedReplicaId",
                       "rounds[1].candidates[0].score"]
```

(Wording is illustrative. The templates are O10's to write; the constraint
is that every value in `text` comes from a path in `cites`.)

---

## O4: `query_decisions` question-to-answer approach

**File:** `src/mcp/tools/query-decisions.ts`

### The call

**Proposed: no LLM inside the tool.** A deterministic parser turns the
question into a structured query, the structured query runs against
`DecisionLog`, and the answer is computed from the returned decisions.

- **Signal from the PRD:** §7 lists no LLM dependency for the routing
  service. The LLM in this system is the MCP *client* (§5.6). By the time
  a question reaches this tool, a client model has already read the user's
  words; the tool's job is to hand back numbers it can stand behind.
- **What we give up:** free-form phrasing. The parser accepts a defined set
  of question shapes, not arbitrary English. That is the honest cost, and
  it is stated in the tool's own "unsupported" response rather than hidden
  (see below).
- **Why that is acceptable:** a client model can rephrase the user's
  question into one of the supported shapes, and the `ok: false` reason
  lists them, so a rejected question is one retry away from working, not a
  dead end. An LLM inside the tool would make the fabrication risk PRD §8
  measures *live in the tool*; keeping it out keeps it in the client, where
  the tool's output can be checked against it.

### Signature

```ts
// src/mcp/tools/query-decisions.ts
export interface QueryDecisionsArgs {
  natural_language_query: string;
}
```

The tool keeps the PRD's single-string argument. No structured-args
alternative for M5a; revisit if the supported shapes prove too narrow in the
M5a demo.

### Supported question shapes

Anything not matching returns `ok: false` (below). Matching is
case-insensitive.

| Shape | Recognized by | Answer |
|---|---|---|
| **Point lookup** | a UUID in the text (the format `crypto.randomUUID()` emits) | delegates to the O3 tool's logic; returns `ExplainRoutingDecisionData` |
| **Aggregate over a range** | a time range (below) plus an aggregate word: `p50`, `p95`, `p99`, `latency`, `count`, `how many`, `failed`, `failures`, `per replica` | `AggregateData` below |

Two UUIDs, or a UUID plus a range, is ambiguous: `ok: false`, reason says to
ask one or the other. The tool never picks one silently.

### Time ranges

Recognized forms, all normalized to `{ from, to }` ISO 8601 UTC strings
before touching `DecisionLog.query` (which compares `at` as strings):

- explicit ISO timestamps: `between <iso> and <iso>`
- clock times on a date: `between 3:00 and 3:10`, `from 15:00 to 15:10`
- relative to now: `last 10 minutes`, `last hour`

**Clock times without a date or zone** are read as the server's local time
on the current date. This is a guess, so the resolved `{ from, to }` is
**always echoed back** in the answer (`range` below). A caller who meant
another zone sees the mismatch instead of a confidently wrong p99.

A range that doesn't parse, has `from` after `to`, or a clock time that
isn't a valid time returns `ok: false`; the tool does not fall back to "all
time."

### Aggregate answer shape

```ts
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
  /** Latency over decisions that have a latency value. null if none do.
   *  `sampleSize` is how many decisions it was computed from, which can be
   *  less than `served`. */
  latency: {
    sampleSize: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } | null;
}
```

- **Percentile method: nearest-rank.** For `n` sorted samples and
  percentile `p`, take the value at 1-based index `ceil(p/100 * n)`. No
  interpolation, so every reported figure is a latency that was actually
  observed, not a value between two of them. With few samples p99 equals
  the maximum, and `sampleSize` is in the answer so the caller can see it.
- **The tool always returns the whole `AggregateData`**, not just the
  figure the question named. Asking for p99 also returns p50, p95, and the
  counts. This keeps the parser from having to decide what the user
  "really wanted" and keeps every answer self-describing.
- **`total === 0` is `ok: false`,** reason `no decisions recorded between
  <from> and <to>`. It is not `ok: true` with zeros: a p99 of 0 for an empty
  window is exactly the fabricated middle ground the grounding constraint
  forbids.
- **`total > 0` but no latency values** (all requests failed) returns
  `ok: true` with `latency: null`. The counts are real; there is no latency
  to report, and the shape says so instead of inventing one.

### The latency gap (needs a joint call)

`Decision` (M4, N2) has **no latency field.** The measured latency exists
only as `latencyMs` in the `POST /route` HTTP response
(`src/api/server.ts`, the `res.json` on the 200 path), which is never
persisted. The task split flagged this (O12); confirmed against the code.
As shipped, `query_decisions` cannot compute any percentile from the
decision log, and PRD §10 explicitly requires it.

Options:

1. **Add `latencyMs?: number` to `Decision`.** Set by the API layer from the
   `latencyMs` the adapter already returns, on the 200 path only; absent on
   every failure path. Additive and optional, so existing recorded
   Decisions and the M4 tests stay valid.
2. **Add it to `DecisionRound` instead.** Per-round latency, including
   failed rounds if the adapter can report one.
3. **Read it from somewhere else** (a separate latency store, or the
   replica's own history).

**Proposed: (1).** The question PRD §10 asks ("what happened to p99") is
about what callers experienced, which is the latency of the request that
succeeded, and that is one number per `Decision`. (2) adds a per-round
figure nothing in M5a needs, and the adapter's error path
(`ReplicaRequestError`) doesn't currently carry a latency to record.
(3) means a second source of truth that has to be joined to `Decision` by
request id and can disagree with it.

This is a change to N2's shape, and M4's contract says N2 changes go
through a PR that updates that doc and the code together, so it is **not
done by this doc alone.** If agreed, the follow-up PR:
- adds `latencyMs?: number` to `Decision` in `src/decisions/types.ts`,
- sets it in `handleRoute` on the 200 path,
- adds a line to `docs/milestones/m4/shared-contract.md` pointing here,
- extends `test/integration/m4.test.ts` with an assertion that a served
  Decision carries the same `latencyMs` the response body returned.

**Also stated so nobody assumes otherwise:** `latencyMs` is the adapter's
end-to-end request latency for the serving replica. It is not the router's
own added overhead (PRD §8's "p99 routing overhead" metric is a different
number and is not answerable from this tool).

### `ok: false` reasons

Fixed set, so callers and tests can rely on them:

| Condition | Reason begins with |
|---|---|
| no UUID and no parseable range | `unsupported question` then the list of supported shapes |
| UUID not in the log | `no decision recorded for request id` |
| range parsed, zero decisions | `no decisions recorded between` |
| ambiguous (UUID plus range, or two UUIDs) | `ambiguous question` |
| range unparseable or inverted | `could not read a time range` |

---

## Also to agree (Junaid's O1/O2 draft settles these, listed so they aren't lost)

- Whether `get_fleet_status()` returns `RegistrySnapshot` verbatim or a
  reshaped read-model.
- Whether `get_failover_history`'s `time_range` is `{ from?, to? }` exactly
  or a friendlier shape. **Constraint from O4 above:** if it takes relative
  forms like "last 10 minutes," it should share one range parser with
  `query_decisions` rather than have two. Suggest that parser live in
  `src/mcp/time-range.ts` and be owned by whoever lands first.

---

## Frozen by this contract

- **`DecisionLog`'s interface** (`record`, `query`, `get`). O3 and O4 are
  read-only consumers of it. Only the `Decision` *record* gains an optional
  field, and only if the latency call above goes through.
- **No LLM calls inside any M5a tool.** Both O3 and O4 depend on this. A
  future tool that needs one is a new decision, not a reopening of this one.

## Not frozen

- **The supported question shapes** in O4. Adding a shape is additive.
  Widening toward free-form English is not planned and would reopen the
  no-LLM call.
- **Summary wording** in O3. The templates are O10's to write and may change
  freely. The `cites` rule may not.

---

## Sign-off checklist

- [ ] O3 (b): raw `Decision` plus derived, cited `lines`; no LLM in the tool
      (Junaid to review).
- [ ] O3: `ok: false` wording does not claim non-existence, given the
      in-memory log (Junaid to review).
- [ ] O4: no LLM in the tool; fixed question shapes; unsupported questions
      rejected with the shape list (Junaid to review).
- [ ] O4: clock times read as server-local, resolved range always echoed
      (Junaid to review).
- [ ] O4: nearest-rank percentiles; empty window is `ok: false`, not zeros
      (Junaid to review).
- [ ] **The latency gap:** add `latencyMs?: number` to `Decision` (option 1),
      or pick another (both).
- [ ] O1 process shape and its `docs/decisions.md` entry (Junaid drafts,
      Arundhati reviews).
- [ ] O2 `ToolResult` shape (Junaid drafts, Arundhati reviews).
- [ ] Shared time-range parser for `get_failover_history` and
      `query_decisions` (both).
