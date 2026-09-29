# M5a Shared Contract (O1 to O4)

**Status:** O1 and O2 drafted by Junaid (2026-09-29), pending Arundhati's
review. O3 and O4 drafted by Arundhati (2026-09-29), pending Junaid's
review. O5 through O14 build against this doc once every box below is checked.
**Covers:** the MCP server's process shape (O1), the tool response envelope
(O2), the `explain_routing_decision` output shape (O3), and the
`query_decisions` natural-language approach (O4).

Landed / to land as:
- O1: `docs/decisions.md` (2026-09-29 entry), `src/main.ts` (wiring, O16)
- O2: `src/mcp/types.ts` (Arundhati, O6, built from the shape below)
- O3: `src/mcp/tools/explain-routing-decision.ts` (signature only)
- O4: `src/mcp/tools/query-decisions.ts` (signature only), plus one
  additive change to `src/decisions/types.ts` (see O4, "The latency gap")

Any change after sign-off goes through a PR that updates this doc and the
affected files together.

---

## O1: MCP server process shape

**Decided: in-process.** The MCP server runs inside the same Node process as
the API server, constructed in `main.ts` and handed the same `Registry`,
`FailoverLog`, `DecisionLog`, and routing config instances the API server
already holds. No second process, no Redis, no network hop.

The reasoning lives in `docs/decisions.md` (2026-09-29) so it stays findable
after M5a closes. The short version: the failover log and decision log are
in-memory too, so Redis for the registry alone would not let a second process
see them, and M5b's action tools need to mutate routing config that only
exists in this process.

**What this fixes for the rest of M5a:**
- **Transport is HTTP, not stdio.** `main.ts` logs to stdout and a stdio MCP
  server owns its process's stdout, so the two cannot share a process. O5
  serves MCP over Streamable HTTP on its own port, bound to `config.host`
  like the API server. The port comes from config (`WR_MCP_PORT`, added in
  O5), not hardcoded.
- **Tools take store instances, not a client.** Each tool factory receives the
  `RegistryStore` / `FailoverLog` / `DecisionLog` it reads as plain arguments,
  the same way `createStatusApp` takes its deps. Tests hand in hand-built
  stores with no server running.
- **Tool handlers are async** even though every store call is synchronous
  today. When M8 splits the deployment and the stores widen to Promises, no
  tool's signature changes.

**Open for O17, not decided here:** how a real client reaches an HTTP server
on localhost (Claude Desktop launches local servers as stdio subprocesses, so
it may need a bridge, and claude.ai needs a reachable URL). This changes how
the demo is wired, not how the server is built, so it does not block O5. If
O17 finds it painful, the fallback is a thin stdio entry point that proxies to
the running HTTP server, still not a second copy of the state.

---

## O2: Tool response envelope (`src/mcp/types.ts`)

Every read tool returns through one shape, so PRD §5.6's grounding constraint
("if the data doesn't support an answer, the tool says so explicitly rather
than inferring") is enforced in one place instead of re-implemented per tool.
Junaid drafts the shape here, Arundhati builds it as O6. O5 (scaffold) and the
tools are written against the types and `dispatch` signature below, so both
tracks can start before O6 merges.

```ts
// src/mcp/types.ts

export type GroundingSource = "registry" | "failover_log" | "decision_log";

export interface Grounding {
  source: GroundingSource;
  /** ISO 8601. Stamped by dispatch when the read ran, never by a tool. */
  queriedAt: string;
  /** Ids of the records the answer was built from: replica ids for the
   *  registry, FailoverEvent.id, or Decision.id. Never empty on an ok result. */
  recordIds: string[];
}

export type ToolFailureCode = "no_data" | "invalid_input" | "internal_error";

/** What a caller of a tool always gets back. */
export type ToolResult<T> =
  | { ok: true; data: T; groundedIn: Grounding }
  | { ok: false; code: ToolFailureCode; reason: string };

/** What a tool handler returns. It never builds a ToolResult itself. */
export type ToolOutput<T> =
  | { kind: "data"; data: T; source: GroundingSource; recordIds: string[] }
  | { kind: "no_data"; reason: string }
  | { kind: "invalid_input"; reason: string };

export type ToolHandler<A, T> = (args: A) => ToolOutput<T> | Promise<ToolOutput<T>>;

export interface DispatchOptions {
  /** Clock for `queriedAt`. Defaults to `() => new Date()`. Tests inject one. */
  now?: () => Date;
}

/** Wrap a handler so every call returns a ToolResult. O6 implements this. */
export function dispatch<A, T>(
  handler: ToolHandler<A, T>,
  opts?: DispatchOptions,
): (args: A) => Promise<ToolResult<T>>;
```

**Rules `dispatch` enforces, once, for every tool:**
- **An `ok: true` result always carries grounding.** A tool cannot return
  data without naming its source and the records behind it, because
  `ToolOutput`'s `data` variant requires both. There is no `ok: true` with
  `data: null` and no partial-success shape: a caller can always tell real
  data from a "no data" response, with no middle ground.
- **Zero records means no data.** If a handler returns `kind: "data"` with an
  empty `recordIds`, `dispatch` turns it into `{ ok: false, code: "no_data" }`.
  This is what makes an empty failover range or an aggregate over zero
  decisions report "no data" instead of a confident-sounding empty answer or a
  computed 0. The `reason` should say what was searched (the range, the
  request id), not just "nothing found".
- **`queriedAt` is stamped by `dispatch`**, not the tool, so a tool cannot
  backdate or omit it.
- **A thrown error becomes `internal_error`**, with the error message as
  `reason`. It never escapes as a rejected promise, so one broken tool cannot
  take down the server.
- **`invalid_input` is for arguments that parse but cannot be honored** (a
  time range with `from` after `to`, an unrecognizable range string). Shape
  validation of arguments stays with the SDK's input schema at registration.

**The protocol mapping belongs to O5, not to this file.** `types.ts` imports
nothing from `@modelcontextprotocol/sdk`, so `dispatch` and every tool stay
testable without a server. O5 converts a `ToolResult` into an MCP
`CallToolResult` at registration: one text content block holding the
`ToolResult` as JSON, with `isError: true` for `invalid_input` and
`internal_error` and `isError: false` for `no_data`. A "no data" answer is a
correct, grounded response, not a failure of the call.

**How O5 builds before O6 lands:** O5 imports these types and calls
`dispatch` from the start. Until O6 merges, `src/mcp/types.ts` on Junaid's
branch holds a stub `dispatch` that stamps `queriedAt` and passes `data`
through with no empty-records or error handling. The signature is the part
that has to match, and this doc is what fixes it.

### Not frozen
- **A tool-call activity hook.** The M6 dashboard wants a feed of MCP tool
  calls (PRD §5.7), and `dispatch` is the natural place to emit it. Not
  designed or built here: `DispatchOptions` grows an optional field when M6
  needs one.
- **Multi-source tools.** `Grounding.source` is a single value because all
  four M5a tools read exactly one store. A future tool that joins two (say,
  decisions plus registry) would change this to an array. That is a new
  question then, not something to pre-build now.

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

The handler returns `kind: "data"` with `source: "decision_log"` and
`recordIds: [decision.id]`, and `dispatch` (O2) wraps it into
`ToolResult<ExplainRoutingDecisionData>`.

### Rules

- **Lookup is `DecisionLog.get(request_id)`, exact match only.** No prefix
  match, no "closest request id." An unknown id returns `kind: "no_data"`
  (surfaced as `code: "no_data"`) with a reason of the form
  `no decision recorded for request id "<id>"`.
- **The `no_data` reason does not claim the request never happened.** The
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
  question into one of the supported shapes, and the `invalid_input` reason
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

Anything not matching returns a failure (see "Failure codes" below). Matching is
case-insensitive.

| Shape | Recognized by | Answer |
|---|---|---|
| **Point lookup** | a UUID in the text (the format `crypto.randomUUID()` emits) | delegates to the O3 tool's logic; returns `ExplainRoutingDecisionData` |
| **Aggregate over a range** | a time range (below) plus an aggregate word: `p50`, `p95`, `p99`, `latency`, `count`, `how many`, `failed`, `failures`, `per replica` | `AggregateData` below |

Two UUIDs, or a UUID plus a range, is ambiguous: `invalid_input`, reason says to
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
isn't a valid time returns `invalid_input`; the tool does not fall back to "all
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
- **`total === 0` is `no_data`,** reason `no decisions recorded between
  <from> and <to>` (O2's zero-records rule, applied as written). It is not
  `ok: true` with zeros: a p99 of 0 for an empty
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

### Failure codes and reasons

Uses O2's codes. Reasons begin with fixed text so callers and tests can
rely on them:

| Condition | Code | Reason begins with |
|---|---|---|
| no UUID and no parseable range | `invalid_input` | `unsupported question` then the list of supported shapes |
| UUID not in the log | `no_data` | `no decision recorded for request id` |
| range parsed, zero decisions | `no_data` | `no decisions recorded between` |
| ambiguous (UUID plus range, or two UUIDs) | `invalid_input` | `ambiguous question` |
| range unparseable or inverted | `invalid_input` | `could not read a time range` |

`recordIds` on a successful answer: the point lookup returns `[decision.id]`;
an aggregate returns the `id` of every decision in range. For a very large
window that list is long. The log is in-memory and demo-scale, so accepted
for M5a.

---

## Still to agree (the task split's "also agree" items)

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

Junaid's items (Arundhati reviewed 2026-09-29):
- [x] O1 in-process decision and its `docs/decisions.md` entry. Checked the
      claims against the code: `main.ts` logs to stdout, `RedisRegistry` is
      still a throwing stub, `config.host` exists. Agreed that HTTP transport
      follows from running in-process.
- [x] O2 envelope: `ToolResult` / `ToolOutput` shapes, the `dispatch`
      signature, and the zero-records-means-no-data rule. Ran both of my
      tools through it (see O3 and O4 above); no changes needed. One note:
      an aggregate's `recordIds` is every decision id in range, which is long
      for a big window and accepted for M5a.

Arundhati's items (pending Junaid):
- [ ] O3: raw `Decision` plus derived, cited `lines`; no LLM in the tool.
- [ ] O3: an unknown id reports `no_data` without claiming the request never
      happened, given the in-memory log.
- [ ] O4: no LLM in the tool; fixed question shapes; unsupported questions
      rejected with the shape list.
- [ ] O4: clock times read as server-local, resolved range always echoed.
- [ ] O4: nearest-rank percentiles; empty window is `no_data`, not zeros.
- [ ] **The latency gap:** add `latencyMs?: number` to `Decision` (option 1),
      or pick another (both).

Joint:
- [ ] `get_fleet_status()` shape (`RegistrySnapshot` verbatim or a read model).
- [ ] `get_failover_history`'s `time_range` shape, and one shared range parser
      with `query_decisions`.
