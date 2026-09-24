# M5a Task Split: MCP Server, Read-Only Tools

**Authors:** Junaid Pathan, Arundhati Vasishth
**Scope:** M5a only (PRD §5.6, §9): stand up the MCP server and its four
read/diagnostic tools (`get_fleet_status`, `explain_routing_decision`,
`get_failover_history`, `query_decisions`), all grounded strictly in live
registry state or recorded log data, no fabricated figures. Action tools
(`drain_replica`, `restore_replica`, `simulate_failure`,
`set_routing_strategy`, `set_scoring_weights`) are M5b, out of scope here.
**Goal of this doc:** split M5a into two tracks of comparable weight, cut so
each person can build and test their track against a shared interface agreed
first, mirroring the [M1](../m1/task-split.md), [M2](../m2/task-split.md),
[M3](../m3/task-split.md), and [M4](../m4/task-split.md) splits.

---

## 1. Principle

M1 through M4 built the three things every read tool in M5a reads from:
live registry state (M1), the routing engine (M2), the failover log (M3),
and the decision log (M4). M5a's job is not to build new state, it is to
expose what already exists through a standard protocol, plus one genuinely
new piece of logic: turning a natural-language question into a grounded
answer.

The natural seam is different in shape from M1 through M4's "pure logic vs.
serving surface" split, because M5a has no pure-logic half: every one of the
four tools is, at bottom, a query against an existing store. The seam that
actually divides the work evenly is **protocol plumbing vs. query
sophistication**:

- **Junaid, MCP Server & State Tools track:** stands up the actual MCP
  server (`@modelcontextprotocol/sdk`, tool registration, the shared
  grounding/error envelope every tool returns through), and implements the
  two tools that are direct reads with no synthesis step:
  `get_fleet_status()` (registry snapshot) and `get_failover_history` (a
  time-range query already shaped exactly like `FailoverLog.query`, per M3).
  This is a new interface-boundary layer, the same shape of work as the M1
  adapter boundary or the M3 error taxonomy: define it once, cleanly, before
  anyone builds on top of it. Continues from the M1 replica/health,
  M2 scoring/strategy, and M3 detection/ejection tracks (owns `src/mcp/`
  new, plus read access to `src/registry/`, `src/events/`).
- **Arundhati, Decision Query & Explainability track:** the two tools that
  require synthesis, not just a lookup: `explain_routing_decision`, which
  turns a `Decision` record into a cited, prose explanation, and
  `query_decisions`, which answers a free-form natural-language question
  against decision-log data, per PRD §10, supporting both point lookups
  ("why did request X go where it did") and aggregate stats ("what happened
  to p99 between 3:00 and 3:10"). This is the direct continuation of the M4
  Decision Log track (owns `src/decisions/`, extends into `src/mcp/tools/`
  for these two tools specifically).

This is not a data-store-ownership split (all four tools ultimately read
stores Arundhati has built across M1-M4: registry, failover log, decision
log), it is a split by **what kind of work each tool requires**: two tools
are a lookup behind a schema, two require actually reasoning about the data
before answering. Balancing on that axis, not on "which store," is what
keeps this even; see §7.

Per the M1 balance note, Junaid's extra load-bearing assist for the
project's overall PRD-suggested split (§11) lands at M5b and M6, not here.
M5a itself stays even between the two of you.

### The one hard design question

`docs/decisions.md` (2026-09-03) flagged `RegistryStore`'s synchronous
interface as good enough "until a Redis-backed store is actually built,
first real need is M5a, when the MCP server becomes a second registry
consumer." M5a is now that milestone, so this has to actually be decided,
not deferred again by default.

**The question:** does the MCP server run as a second process (matching the
PRD §6 architecture diagram, which draws it as a separate box), requiring
Redis now so two processes can share registry state? Or does it run
in-process, inside the same Node process as the API server, sharing the
exact same `Registry`/`FailoverLog`/`DecisionLog` instances directly, the
same way M1's health scheduler stayed in-process "until Docker/K8s exist to
manage" multi-service coordination (`docs/decisions.md`, 2026-09-03)?

**The leading answer, to confirm in the shared contract, not assume here:**
in-process, same pattern as every prior deferral of this shape. Docker/K8s
don't exist until M7/M8; standing up a second process and a Redis dependency
now, only to re-architect it again once K8s exists to actually manage
multiple deployments, is exactly the kind of premature multi-process
complexity M1's own health-scheduler decision already argued against. The
MCP server mounts inside the existing Node process (`main.ts`), reads the
same in-memory store instances directly, no network hop, no Redis. This
keeps `RegistryStore` synchronous for one more milestone; the interface
still widens to `Promise`-returning exactly when Redis actually lands
(M7/M8, per the existing decision), not before.

If this is agreed, it should be its own `docs/decisions.md` entry
(superseding nothing, just resolving the deferred question the 2026-09-03
entry raised), settled in O1 below before either track writes code that
assumes one shape or the other.

---

## 2. Shared contract (design together first, ~45 min, before any code)

Agree on and commit these before splitting off. Junaid drafts O1 and O2,
Arundhati drafts O3 and O4, both review the whole thing.

| Item | File | Notes |
|---|---|---|
| **O1** MCP server process shape | `docs/decisions.md` | Resolves "the one hard design question" above: in-process, same Node process as the API server, direct references to the existing store instances. No Redis, no second process, for M5a. |
| **O2** Tool response envelope | `src/mcp/types.ts` | Every read tool returns through one shape so the grounding constraint (PRD §5.6: "if the data doesn't support an answer, the tool says so explicitly rather than inferring") is enforced structurally, not left to each tool's discretion. Something like `ToolResult<T> = { ok: true; data: T; groundedIn: { source: "registry" \| "failover_log" \| "decision_log"; queriedAt: string } } \| { ok: false; reason: string }`. Exact shape is O1/O2's job to nail down together; the constraint is that a caller can always tell whether an answer came from real data or a "no data for that" response, never a fabricated middle ground. |
| **O3** `explain_routing_decision` output shape | `src/mcp/tools/explain-routing-decision.ts` (signature only) | What "cited" means concretely: does the tool return prose with inline references to specific `DecisionRound` fields, or structured data (the full `Decision` plus a short human-readable summary) and let the MCP client's own model do the prose? PRD §5.6 says "grounded, cited explanation," which doesn't by itself decide whether prose generation happens in this tool or in the calling client. Settle this before O11 is built: it changes whether this tool needs any LLM access of its own. |
| **O4** `query_decisions` NL-to-query approach | `src/mcp/tools/query-decisions.ts` (signature only) | The harder version of O3's question: does `query_decisions` parse `natural_language_query` itself (keyword/date-range extraction into a structured `DecisionLog.query` call, no LLM in the router), or does it call out to an LLM to interpret the question and ground its answer against fetched decision-log data? The PRD's tech stack (§7) lists no LLM dependency for the routing service itself, only for the MCP client side (§5.6, "MCP client... Claude Desktop"), which is a real signal toward "no LLM call inside the tool," but this is explicitly not decided by that alone and needs to be settled here, not assumed by whoever starts building O12 first. |

Also agree: whether `get_fleet_status()`'s shape is just `RegistrySnapshot`
verbatim or a slightly different read-model shaped for MCP clients, and
whether `get_failover_history(time_range)`'s `time_range` argument shape
matches `FailoverLog.query`'s `{ from?, to? }` exactly or needs a friendlier
MCP-facing shape (e.g. relative ranges like `"last 10 minutes"`) that gets
normalized to `{ from, to }` before hitting the store.

### Frozen by this contract (do not change in M5a)

`RegistryStore`, `FailoverLog`, and `DecisionLog`'s existing synchronous
interfaces do not change (per O1). M5a is a new consumer of all three, not a
reason to widen any of them; that widening is still tied to Redis actually
landing, per the existing 2026-09-03 decision. Record in `docs/decisions.md`
that M5a resolved the deferred question by choosing in-process, not that it
reopened the interface itself.

---

## 3. Junaid: MCP Server & State Tools track

| # | Task | Deliverable |
|---|---|---|
| O5 | **MCP server scaffold** | `src/mcp/server.ts`: stand up the server using `@modelcontextprotocol/sdk`, register tools against it, wire it into `main.ts` per O1 (in-process, same store instances the API server already holds). No transport-layer redesign: this is additive to `main.ts`, the same shape as M3's failover-log wiring or M4's decision-log wiring. |
| O6 | **Tool dispatch + grounding envelope** | `src/mcp/types.ts`: implement O2's `ToolResult` shape and a small dispatch helper every tool call goes through, so "no data, say so" is enforced once, centrally, not re-implemented per tool. |
| O7 | **`get_fleet_status()`** | `src/mcp/tools/get-fleet-status.ts`: reads `RegistryStore.getSnapshot()` directly, wraps it in O2's envelope. The most direct possible read tool; exists to prove the scaffold works end to end before O8's slightly more involved range query. |
| O8 | **`get_failover_history(time_range)`** | `src/mcp/tools/get-failover-history.ts`: reads `FailoverLog.query({ from?, to? })`, normalizing whatever `time_range` shape O4's "also agree" note settles on into the store's native range shape. |
| O9 | **Unit tests** | scaffold registers exactly the four M5a tools and no M5b action tools yet; grounding envelope correctly distinguishes a real result from a "no data" result; `get_fleet_status` matches a hand-built registry snapshot; `get_failover_history` against a seeded failover log, including an empty range and an out-of-range query returning no data cleanly. |

---

## 4. Arundhati: Decision Query & Explainability track

| # | Task | Deliverable |
|---|---|---|
| O10 | **`explain_routing_decision(request_id)`** | `src/mcp/tools/explain-routing-decision.ts`: `DecisionLog.get(requestId)`, then build the O3-shaped output. If `get()` returns `undefined`, the tool says so explicitly (O2's grounding envelope), it does not guess or return a similar-looking decision. |
| O11 | **`query_decisions(natural_language_query)`, point-lookup case** | `src/mcp/tools/query-decisions.ts`: the "why did request X go where it did" shape from PRD §10, built against O4's agreed approach. If O4 settles on no-LLM-in-the-router, this is largely a thin wrapper around O10's logic keyed off a request id extracted from the query text; if O4 settles on an LLM call, this is where that integration lives. |
| O12 | **`query_decisions`, aggregate case** | Extends O11 to the "what happened to p99 between 3:00 and 3:10" shape from PRD §10: a time-range query over `DecisionLog.query({ from, to })` plus percentile computation over the returned decisions' latency data (latency itself lives on the M2/M3 response path, not on `Decision` directly, confirm in the shared contract whether `DecisionRound` needs a field for it or whether this reads through `attempts`/response data some other way, since `Decision` as currently shaped has no latency field at all). |
| O13 | **Grounding-constraint enforcement for both tools** | Explicit test/assertion surface: a query with no matching data returns O2's "no data" shape, never a fabricated number or a plausible-sounding guess. This is the PRD §8 "Explainability accuracy: 100% of answers grounded in decision-log values" success metric, owned end to end by this track. |
| O14 | **Unit tests** | `explain_routing_decision` for a real request id, an unknown one, and a multi-round retried decision (confirms the full retry story surfaces, not just the winning round); `query_decisions` point-lookup and aggregate cases against a seeded decision log, plus the grounding-constraint no-data case from O13. |

---

## 5. Joint tasks

| # | Task | Split |
|---|---|---|
| O15 | **Shared contract doc** in `docs/milestones/m5a/shared-contract.md`: the O1 through O4 decisions written up the way M2's through M4's were, plus the `docs/decisions.md` entry resolving the in-process-vs-Redis question. | pair, Junaid drafts O1/O2, Arundhati drafts O3/O4 |
| O16 | **Main wiring** in `src/main.ts`: construct the MCP server per O5, pass it the same registry/failover-log/decision-log instances the API server already holds. Small diff on top of M4's `main.ts`. | whoever finishes their track first drafts, other reviews |
| O17 | **MCP client demo wiring**: connect the running server to Claude Desktop (or `claude.ai`) per PRD §5.6, confirm all four tools are visible and callable from a real MCP client, not just from unit tests driving the tool functions directly. | pair, since this is the first time either track's work is exercised through the actual protocol rather than as a plain function call |
| O18 | **M5a architecture review + README update** in `docs/architecture/m5a.md`, same shape as [`m4.md`](../../architecture/m4.md): confirm no action-tool (M5b) or dashboard (M6) concerns leaked in, confirm the grounding constraint holds end to end (PRD §8's explainability metric), report the in-process design decision and why, both sign off. Update the README with the MCP server and how to point Claude Desktop at it. | both |

Everything else, O5 through O9 and O10 through O14, is single-owner. The
only cross-track dependency is O5/O6 (Arundhati's tools need the scaffold
and envelope to exist, even as a stub, before they can be registered) and
O16/O17 at the end.

---

## 6. Sequencing

1. **Day 1:** O15 shared contract (together, ~45 min); settle O1 (in-process
   vs. Redis) and O4 (NL-query approach) before any code, since both change
   the shape of what gets built.
2. **Day 1-2:** Junaid O5-O6 (scaffold + envelope), Arundhati starts O10
   against a stubbed envelope shape agreed in O2, swapping to the real one
   once O6 merges.
3. **Day 2-3:** Junaid O7-O8, Arundhati O11-O12.
4. **Day 3-4:** Junaid O9 tests, Arundhati O13-O14.
5. **Day 4:** O16 wiring (whoever is free first drafts, other reviews same
   day).
6. **Day 4-5:** O17 MCP client demo wiring (pair, since it's the first real
   end-to-end protocol test).
7. **Day 5:** O18 review and sign-off.

Only hard dependency: Arundhati's tools need O2's envelope shape agreed (not
built) before O10 starts, same pattern as every prior milestone's "interface
agreed, implementation can lag" rule.

---

## 7. Effort balance check

| | Junaid | Arundhati |
|---|---|---|
| Shared design authoring | O1 process shape + O2 tool envelope | O3 explain shape + O4 NL-query approach |
| Large module | MCP server scaffold + dispatch envelope (O5, O6) | `query_decisions` point + aggregate cases (O11, O12) |
| Medium module | `get_fleet_status` + `get_failover_history` (O7, O8) | `explain_routing_decision` (O10) |
| Small module | (none) | grounding-constraint enforcement surface (O13) |
| Tests | own module (O9) | own modules (O14) |
| Joint | O15-O18, split evenly | same |

Each side: half the shared contract authored, two tools each, own unit
tests, half of every joint task. Junaid's side is weighted toward new
protocol infrastructure (no prior milestone built anything like the MCP
scaffold); Arundhati's side is weighted toward query sophistication (NL
grounding, aggregate percentile computation), the more analytically involved
half. Neither is strictly "the two easy tools vs. the two hard tools": O8
(range-query normalization) and O5/O6 (protocol plumbing with no existing
pattern to copy) carry real design weight of their own.

---

## 8. Working agreement

The commit / branch / PR / review rules live in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
at the repo root. They are project-wide, not M5a-specific. In force for all
of M5a.

---

## 9. Definition of done (M5a)

- The MCP server runs in-process, exposed to a real MCP client (PRD §5.6),
  with exactly the four read tools registered, no action tools yet.
- `get_fleet_status()` returns live registry state, matching `GET /status`.
- `get_failover_history(time_range)` returns real `FailoverLog` data for the
  given range, empty and out-of-range queries handled cleanly.
- `explain_routing_decision(request_id)` returns a grounded, cited
  explanation for a real request id, and says explicitly when a request id
  has no recorded decision, never guesses.
- `query_decisions(natural_language_query)` answers both a point lookup and
  an aggregate/time-range question, grounded strictly in decision-log data.
- The grounding constraint holds for all four tools: no answer is ever
  fabricated or inferred beyond what recorded data supports (PRD §8's
  explainability metric, measured, not just asserted).
- Demoed live through an actual MCP client (Claude Desktop or `claude.ai`),
  not only through unit tests calling tool functions directly.
- Unit + integration tests green in CI.
- Both authors have signed off in M5a's architecture review (O18).
