# M5a Architecture Review

**Reviewers:** Arundhati Vasishth (draft), Junaid Pathan (pending)
**Date:** 2026-10-10
**Purpose:** Walk the MCP read-tool seam before M5b. Confirm the four read
tools answer only from live or recorded data, that the grounding rule is
enforced in one place and not per tool, that the in-process design held, and
that no action-tool (M5b) or dashboard (M6) concern leaked into M5a code.

**Scope reviewed:** everything on `main` at merge of PR #55: `src/mcp/`
(`types.ts`, `server.ts`, `time-range.ts`, `tools/*`), the MCP wiring in
`src/main.ts` and `WR_MCP_PORT` in `src/config.ts`, the `latencyMs` field on
`Decision` (`src/decisions/types.ts`), `docs/milestones/m5a/shared-contract.md`,
`docs/decisions.md`, the README's MCP section, and the test suite (270 tests,
including `test/mcp-read-tools.test.ts` and `test/integration/m5a.test.ts`,
which drive the tools through a real MCP client over HTTP).

---

## 1. The bet: one place where "no data" is enforced

> PRD §5.6: "if the data doesn't support an answer, the tool says so
> explicitly rather than inferring."

**Verdict: correctly implemented, with one gap in how §8's metric is measured
(see §6).**

The task split's central design choice was to enforce the grounding rule once,
in `dispatch` (`src/mcp/types.ts`), instead of leaving each tool to remember
it. That held:

- A tool handler never builds a `ToolResult`. It returns a `ToolOutput`
  (`data`, `no_data`, or `invalid_input`) and `dispatch` makes the result.
- `server.ts` only accepts what `defineTool` returns, and `defineTool` wraps
  the handler in `dispatch`. A tool cannot reach the protocol without going
  through the envelope. `test/mcp-server.test.ts` checks that a call is routed
  through `dispatch`, and that a throwing tool becomes `internal_error` while
  the server stays up.
- `dispatch` turns `data` with zero record ids into `no_data`. This is the
  rule that stops an empty window from reading as a computed zero. It is what
  makes `query_decisions` over an empty range, and `get_failover_history` over
  a quiet window, report "nothing recorded" and not `0` or `[]` with `ok: true`.
- `no_data` is a correct answer, not a failed call. `toCallToolResult` sets
  `isError` only for `invalid_input` and `internal_error`, and
  `test/mcp-read-tools.test.ts` asserts `isError === false` for a `no_data`
  response over the wire.

## 2. Does the code match the final architecture (PRD §6)?

| Diagram element | M5a state | OK? |
|---|---|---|
| MCP server exposing read tools | `src/mcp/server.ts`, Streamable HTTP, started from `main.ts` | ✅ |
| Server is a separate box | in-process in the API server's Node process, by decision (§3) | ✅ deliberate difference, recorded |
| `get_fleet_status` | `RegistrySnapshot` verbatim, grounded in `registry` | ✅ |
| `get_failover_history` | `FailoverLog.query` over an ISO range or a `last` phrase | ✅ |
| `explain_routing_decision` | recorded `Decision` plus cited `lines`, no LLM | ✅ |
| `query_decisions` | point lookup and range aggregate, no LLM | ✅ |
| Action tools (drain, restore, simulate failure, strategy, weights) | not registered | ✅ absent |
| Dashboard | not in M5a (M6) | ✅ absent |

## 3. The in-process decision

`docs/decisions.md` (2026-09-29) resolved the question the 2026-09-03
`RegistryStore` entry deferred to M5a: the MCP server runs inside the API
server's process and reads the same `Registry`, `FailoverLog`, and
`DecisionLog` instances directly. No Redis, no second process.

**Held.** `createReadTools` takes the three stores as plain arguments and
`main.ts` passes the same instances the API server already holds. None of the
three store interfaces changed. `RedisRegistry` is still a throwing stub.

Two consequences worth stating:

1. **HTTP, not stdio.** `main.ts` owns stdout for its own logging, so stdio
   transport was never available in-process. The server listens on
   `WR_MCP_PORT` (default 8090), validated in `config.ts` against the replica
   port range and the status port.
2. **Stateless per request.** Each `POST /mcp` builds a fresh `McpServer` and
   transport. The tools close over the stores, so there is no session state to
   leak, and `GET` and `DELETE` on `/mcp` return 405.

The real trigger for a separate MCP deployment, and for widening the store
interfaces to `Promise`, is now M8, per the update on the 2026-09-03 entry.

## 4. Findings

### 4.1 Clock times in a question are a server-local guess

`query_decisions` and `time-range.ts` read `between 3:00 and 3:10` as the
server's local time on the current date. A caller in another zone, or asking
about yesterday, gets a confident answer about the wrong window. **Mitigation
that is in place:** the resolved `{ from, to }` is always echoed in the
answer (`AggregateData.range`), and an unreadable or inverted range is
`invalid_input` rather than a fall back to all time. Not fixed; the echo is
the control.

### 4.2 `latencyMs` is request latency, not routing overhead

The p99 `query_decisions` returns is the adapter's end-to-end latency for the
replica that served the request (`Decision.latencyMs`, set on the 200 path
only). PRD §8's "p99 routing overhead < 10ms" is a different number and is
not answerable from this tool. The shape says so in its own comment, and
`sampleSize` is reported so a caller can see when a percentile rests on few
samples (with few samples nearest-rank p99 equals the maximum).

### 4.3 `recordIds` on an aggregate is every decision id in range

A long window returns a long list. Accepted in the contract for the
in-memory, demo-scale log. Revisit if the log is ever persisted (M7/M8).

### 4.4 A real bug found while wiring: integration tests collided on port 8090

After the MCP server was wired into `main.ts`, the m1 and m2 integration tests
(which spawn `main.ts` as a child process) did not set `WR_MCP_PORT`, so every
spawned instance tried to bind the default 8090. Vitest runs test files in
parallel, so a second instance could fail to start with `EADDRINUSE`. Fixed:
each test now sets `WR_MCP_PORT` to its own port, `statusPort + 5`, chosen to
avoid the replica ports that follow `WR_BASE_PORT`. m3 and m4 build the system
in-process and did not need the change.

### 4.5 A timing-sensitive test, not caused by M5a

While verifying 4.4, `m2 > latency-weighted also favours the lowest-cost
replica` failed once in three runs with m1 and m2 running together, and passed
every other time (alone, and in two further paired runs). It is
latency-sensitive and a `junaid/fix-flaky-m2-latency-test` branch shows it has
been flaky before. Recorded, not fixed here.

## 5. Leakage check: did any later-milestone concern get built in?

Grepped `src/` for `drain_replica`, `restore_replica`, `simulate_failure`,
`set_routing_strategy`, `set_scoring_weights`, and `dashboard`.

**Zero hits in implementation outside `src/routing/`**, where the action tool
names appear only in comments explaining the shape of the routing config
(pre-existing since M2). The only registered tools are the four read tools;
`test/mcp-read-tools.test.ts` asserts the exact list and that none of the five
action tool names is present. No LLM dependency exists in `src/`: the two
tools that produce prose or answer free-form questions are deterministic, as
the contract froze.

## 6. Success metrics (PRD §8): status

**Explainability accuracy: 100% of answers grounded in decision-log values, no
fabricated figures.**

What is verified:

- Structural: every figure in an `explain_routing_decision` line is
  interpolated from the value at one of that line's `cites`, and
  `resolveCite` lets a test (and a client) check each claim against the
  record. A replica the record does not mention gets no sentence.
- `query_decisions` computes only from decisions the log returns, uses
  nearest-rank percentiles so every reported latency was actually observed,
  and returns `no_data` for an empty window and `latency: null` when no
  decision in range has a latency value.
- An unknown request id, an empty window, a missing range, an ambiguous
  question, and an unreadable range each have a test asserting the specific
  non-fabricating response.

- End to end through a client: `test/integration/m5a.test.ts` routes real
  traffic, kills a replica, and asks all four tools about it through the MCP
  SDK's client over HTTP. It checks that the explain output equals the
  recorded decision and every cited path resolves, that the aggregate's p99
  equals the slowest latency the client actually received, and that every
  `recordIds` list matches the ids in the underlying store.

**What is not yet verified, stated plainly:** the task split's definition of
done says the metric should be "measured, not just asserted." The integration
test measures the tools' output against real recorded data through a real
protocol client. It does not measure a client *model's* prose answer against
that output, and it does not check that a line's wording matches the value at
its cite (the unit tests in `test/mcp-explain.test.ts` cover the wording).
Junaid reports separately checking a stdio client reaching the running server
through `mcp-remote`, the route Claude Desktop uses (all four tools listed,
`get_fleet_status` returned live data); that is his check, not part of the
test suite. Claude Desktop itself has not been run against the server, so
"100% grounded" is established for the tools' output, not for what a model
says about it.

## 7. Known deferrals: carry into M5b, do not fix now

1. **`DecisionLog` and `FailoverLog` are in-memory and unbounded** (unchanged
   from M3/M4). A restart loses the history M5a answers from.
2. **Question shapes are fixed.** `query_decisions` accepts a defined set and
   lists them when it rejects one. Widening toward free-form English would
   reopen the no-LLM decision.
3. **`get()` and `query()` are linear scans** (unchanged from M4).
4. **`RegistryStore` is still synchronous.** M5a did not force the widening;
   M8 is the trigger.
5. **No authentication on `/mcp`.** It binds `127.0.0.1` by default, which is
   fine for the demo and read-only tools. M5b adds tools that change state,
   so this has to be decided before any action tool is registered.

## 8. M5a definition of done (from the task split)

- [x] The MCP server runs in-process with exactly the four read tools
  registered and no action tools (`test/mcp-read-tools.test.ts`)
- [x] `get_fleet_status()` returns live registry state matching `GET /status`
  (`test/mcp-get-fleet-status.test.ts`)
- [x] `get_failover_history(time_range)` returns real `FailoverLog` data, with
  empty and out-of-range windows handled cleanly
- [x] `explain_routing_decision(request_id)` returns a grounded, cited
  explanation and says explicitly when a request id has no recorded decision
- [x] `query_decisions` answers a point lookup and an aggregate/time-range
  question, grounded in decision-log data
- [x] The grounding constraint holds for all four tools at the tool level (§6)
- [x] The grounding constraint is **measured** against real recorded data
  through an MCP client over HTTP (`test/integration/m5a.test.ts`, §6)
- [ ] Demoed live through Claude Desktop or `claude.ai`; a model's prose answer
  checked against the tool output (§6)
- [x] README documents the server and how to point a client at it (PR #55)
- [x] Unit + integration tests green in CI (270)
- [ ] Both authors have signed off (this document; Junaid's review pending,
  see §9)

## 9. Sign-off

- [x] Shared contract O1 to O4 and the state tools' argument shapes: agreed in
  `docs/milestones/m5a/shared-contract.md` (both)
- [x] Dispatch and grounding envelope, `explain_routing_decision`,
  `query_decisions`, the `latencyMs` field: built and self-reviewed
  (Arundhati, PRs #45, #46, #47, #52)
- [x] M5a integration test and README section: built by Junaid (PRs #53,
  #55); both reviewed and run locally before merge, test run twice from a
  clean worktree (Arundhati)
- [x] Server scaffold, `get_fleet_status`, `get_failover_history`, the shared
  range parser, `main.ts` wiring: built by Junaid (PRs #48, #49, #50, #51);
  wiring PR #51 re-run locally (typecheck and full suite) before merge
  (Arundhati)
- [ ] **Junaid's review of this document is pending.** Drafted solo, flagged
  plainly rather than claimed as a completed mutual sign-off, consistent with
  how the M3 and M4 reviews handled the same situation.
- [ ] **Claude Desktop demo not yet run.** The open demo item in §8 depends on
  it, and so does checking a model's answer against the tool output.

**M5a is functionally complete and merged to `main`, apart from the live
Claude Desktop demo. Closed pending Junaid's read of this document and that
demo.**
