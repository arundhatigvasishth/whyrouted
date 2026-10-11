# M5b Architecture Review

**Reviewers:** Arundhati Vasishth (draft), Junaid Pathan (review pending)
**Date:** 2026-10-11
**Status:** draft. Not signed off. Two items are open: Junaid's review of this
document and the live Claude Desktop demo (section 6.1).
**Purpose:** Walk the MCP action-tool seam before M6. Confirm the five action
tools change only what they say they changed, that no action is reachable
without the auth gate, that drain is operator intent held apart from health,
that the four M5a read tools were not weakened, and that no dashboard (M6)
concern leaked in.

**Scope reviewed:** everything on `main` plus the two open M5b PRs that
complete it (the drain and restore tools with the `main.ts` wiring, #65, and
the integration test, #67). This document should merge after them. Files:
`src/mcp/` (`action.ts`, `auth.ts`, `server.ts`, `tools/*`), the drained state
in `src/types.ts`, `src/registry/`, and `src/routing/engine.ts`,
`src/replica/fault-injector.ts`, `WR_MCP_TOKEN` in `src/config.ts`, the wiring
in `src/main.ts`, `docs/milestones/m5b/shared-contract.md`,
`docs/decisions.md`, the README, and the test suite (391 tests, including
`test/integration/m5b.test.ts`, which drives every action tool through a real
MCP client over HTTP with the token on).

---

## 1. The bet: one place where an action's result is made

M5a enforced "no data, say so" once, in `dispatch`. M5b makes the matching
bet for writes: a tool cannot claim an effect it did not have.

**Verdict: held.**

- A handler never builds an `ActionResult`. It returns an `ActionOutput`
  (`applied`, `unknown_replica`, `invalid_input`, `unsupported`) and
  `performAction` makes the result (`src/mcp/action.ts`).
- `server.ts` only accepts what `defineActionTool` returns, and that wraps the
  handler in `performAction`. An action tool cannot reach the protocol without
  going through the envelope.
- `changed` is derived by the wrapper from `before` and `after` with deep
  equality, so a tool cannot report a change that did not happen or hide one
  that did. With no `before` it is `null`, "cannot tell", never a guess. Only
  `simulate_failure` returns no `before`, because a replica has no state-read
  endpoint and the admin surface is frozen.
- `after` is read back from the store after the write. Drain and restore read
  the registry snapshot, the routing tools read `RoutingConfig`, and
  `simulate_failure` returns the replica's own `{ killed, inferFailing }`
  report. None echo the request arguments. The integration test then checks
  the effect through a second path (`get_fleet_status`, `GET /status`,
  `POST /route`, the decision log), so the tool's own answer is not the only
  evidence.
- A failed action changed nothing. `unknown_replica`, `invalid_input`, and
  `unsupported` are decided before any write, and each tool's tests assert
  the store is unchanged afterwards.
- Every failure sets `isError`, including `unsupported`. Unlike a read's
  `no_data`, "nothing happened" is not a correct answer for an action. A
  successful no-op (`changed: false`) is not an error.

## 2. Does the code match the final architecture (PRD section 6)?

| Diagram element | M5b state | OK? |
|---|---|---|
| MCP server exposing read and write tools | nine tools, `createReadTools` (4) and `createActionTools` (5), pinned by `test/mcp-tool-set.test.ts` | yes |
| `drain_replica`, `restore_replica` | operator intent on `ReplicaState.admin`, engine pre-filter | yes |
| `simulate_failure` | `FaultInjector` over the replicas' admin endpoints, simulated fleet only | yes |
| `set_routing_strategy`, `set_scoring_weights` | `RoutingConfig` setters, read back | yes |
| Phase 1 to Phase 2 swap "no MCP code changes" | `ReplicaAdapter` still two functions; fault injection is a separate interface and `simulate_failure` returns `unsupported` without one | yes |
| Server is a separate box | still in-process, by the M5a decision | deliberate difference, recorded |
| Dashboard | not in M5b (M6) | absent |

## 3. Drained state is operator intent, held apart from health

`docs/decisions.md` (2026-10-11) records the choice. `ReplicaState` gains
`admin: "active" | "drained"` beside `runtime`, set only by
`RegistryStore.setAdmin`.

**Held, and the reason is checkable in the types.** The health scheduler
writes through `HealthSink = Pick<RegistryStore, "updateRuntime" |
"setHealth">`, and `updateRuntime` takes `Partial<ReplicaRuntime>`. A field on
`ReplicaState` is therefore unreachable from the scheduler at the type level,
with no change to M1 code. `test/health-scheduler.test.ts` also pins it:
a drained replica stays drained across a healthy, unhealthy, and recovered
sequence. The alternative, a `"draining"` health value, would have been
overwritten within one poll interval.

- The engine excludes a drained replica in the same pre-filter as an
  unhealthy one, so no strategy sees it and the `pick` and `score` signatures
  did not change. The reason is `drained`, and it wins over `unhealthy` when a
  replica is both: the operator's action is the more specific cause, and
  fixing the replica's health would not return it to rotation.
- "Graceful" needed no connection tracking. The engine decides at pick time, so
  requests already sent to the replica finish. The integration test checks no
  request after the drain reaches it and none fail.
- `restore_replica` clears only the drain. For a replica that is also
  unhealthy it returns `routable: false` and a note, so it never implies the
  replica is back in rotation.
- Draining the last routable replica is allowed and reported (a note, and
  `routableReplicas: 0`). The operator asked, and a `503` with every
  exclusion listed is an honest outcome. See 4.3 for a wording problem this
  exposes.

`GET /status` and `get_fleet_status` gain an `admin` field per replica. That
is additive to the M1 shape; two snapshot tests were updated for it.

## 4. Findings

### 4.1 Operator actions leave no history

Drain, restore, strategy and weight changes, and injected faults are not
written to any log. `get_failover_history` records only the health
scheduler's ejections and recoveries, and nothing records who or what drained
a replica, or when. A person can see the current `admin` state and, for
requests made while it was drained, the `drained` exclusion in the decision
log, but cannot ask "when was replica-2 drained". The contract says plainly
that the token is not an audit trail; this is the other half of that. Not
fixed. Recorded for M6 or later, when a dashboard would want an event feed.

### 4.2 The token guards `/mcp`, not the things the tools call

`WR_MCP_TOKEN` and the refusal to register action tools on a non-loopback bind
protect the MCP endpoint. `WR_HOST` is a single setting that the replicas, the
API server, and the MCP server all bind to. With `WR_HOST=0.0.0.0` and a
token set, `/mcp` requires the token, but each replica's `POST /admin/kill`
and the API server's `/route` and `/status` are open on the network with no
authentication (the replicas' admin endpoints were built for local
fault-injection demos in M1 and M3). So the statement "the unsafe
configuration is impossible" holds for the MCP action tools, not for the
fleet as a whole. For the localhost demo this is not exploitable, and the
README now says the token only guards `/mcp`. Not fixed; the real control is
network policy and an ingress in M8.

### 4.3 `POST /route` says "no healthy replicas" when they are drained

When every healthy replica is drained, the engine takes the existing
`no_healthy_replicas` path, and `POST /route` returns that error name even
though the replicas are healthy. The decision log and `explain_routing_decision`
are correct (each replica is listed as `drained by operator`, and the round
line says "no replica was available to route to", not that the fleet was
unhealthy). The HTTP error code is the one place that still reads as a health
problem. The contract chose to keep the code name rather than change the M2
response shape. Not fixed; revisit if a client needs to tell the two apart.

### 4.4 Drain, strategy, and weights reset on restart

All three live in memory, like the registry and the logs. A restart returns
every replica to `active` and the strategy and weights to their environment
values. The same limit as M5a's logs; persistence waits for the Redis-backed
store (M7/M8). Worth knowing before the demo: restarting the service is not a
way to "keep" an operator change.

### 4.5 M5b touched a read tool

The task split froze the four read tools. Two things changed in their files and
behaviour, both deliberate and tested:

- `get_fleet_status` and `get_failover_history` only changed a declared return
  type (`ToolDefinition` to `ReadToolDefinition`), because `ToolDefinition`
  became a union. No behaviour change; every M5a read test passed unmodified.
- `explain_routing_decision` has a real change: it words the new `drained`
  exclusion reason as "drained by operator", and a round with nothing routable
  says "no replica was available to route to" when any exclusion is a drain
  (otherwise it would call a healthy fleet unhealthy). This widens an M4 type,
  so the M4 shared contract's exclusion-reason section was updated in the same
  PR. The `cites` rule is unchanged, and the cite still points at the recorded
  `excluded[k].reason`.

### 4.6 The task split was wrong about the scoring weights

The split said only round-robin ignores the scoring weights. Junaid checked
the code: only `latency-weighted` reads them, so the default strategy,
`least-loaded`, ignores them too. Left alone, `set_scoring_weights` under
default settings would succeed and change nothing a client can see. The tool
now adds a note whenever the active strategy is not `latency-weighted`, and
the split was corrected. This is also a reminder that a successful action is
not the same as an effective one.

### 4.7 `simulate_failure` reports the fault, not its effect

A kill is injected immediately but shows as `unhealthy` only after the health
checks notice, about 1.5 seconds at the default settings. The result says so
and points at `get_fleet_status` rather than claiming the replica is down.
This is also why PRD section 8's "reflected within 1s" is asserted for drain,
restore, and strategy changes, and not for the health consequence of a kill.

### 4.8 A timing-sensitive test failed twice in CI, not caused by M5b

`m2 > latency-weighted also favours the lowest-cost replica` failed on the
first CI run of two different PRs (#60 and #62; neither touches the test or the
latency-weighted strategy) with replica-1 getting 11 and 13 requests against a
floor of 16, and passed on rerun. It is the same flake M5a recorded (4.5 there). Recorded,
not fixed here; it has now failed in CI and not only locally.

### 4.9 Auth branch needed a merge to land

PR #63 (auth) conflicted with `main` after the envelope PR merged, over two
import blocks in `server.ts`. The conflict was resolved by merging `main` into
`junaid/mcp-auth` and keeping both blocks; the full suite passed before the
merge. Noted because Arundhati pushed the resolution to a branch Junaid owned,
to land the PR.

## 5. Leakage check: did any later-milestone concern get built in?

Grepped `src/` for `dashboard`: zero hits. No LLM dependency exists in `src/`.
The M5a read tools still answer only from recorded data, the same four names,
and `test/mcp-tool-set.test.ts` pins exactly four read tools and exactly five
action tools, nine total, and that on a non-loopback bind with no token the
five action tool names are absent from the list, not present and rejecting.

## 6. Success metrics (PRD section 8): status

**MCP action reliability: 100% of drain, restore, and strategy-change tool
calls correctly reflected in live fleet state within 1s.**

Measured in `test/integration/m5b.test.ts`, through a real MCP client over
HTTP, against a live fleet:

- **Drain:** the tool call, a `get_fleet_status` read, and a `GET /status` read
  all complete inside a 1s bound and show `admin: "drained"`. Then 12 routed
  requests: all succeed, none reach the drained replica.
- **Restore:** the tool call and 9 routed requests complete inside 1s, and all
  three replicas receive traffic again.
- **Strategy change:** the call plus the very next `POST /route` complete
  inside 1s, and the response and the recorded decision both name the new
  strategy.
- **Weights:** the stored weights equal the request, and invalid values leave
  them unchanged. Whether new weights change a pick is not measured; the
  routing engine tests cover that.

What this does and does not show, stated plainly: the bound is on the whole
sequence (action, then verification reads), not a loop polling until the
change appears, and the registry is in memory, so the change is visible
immediately. The 1s margin would only matter once state lives behind Redis
(M7/M8) and this test should be revisited then. The test was stable over
three runs.

**Explainability accuracy** (carried from M5a): the integration test checks
that a decision made after a drain is recorded with the `drained` reason and
that `explain_routing_decision` words it as an operator action, never as
`unhealthy`.

**What is not verified:** that a client model describes a drain correctly in
its own prose. As in M5a, the tools' output is measured; a model's paraphrase
of it is checked by eye in the demo, not measured.

### 6.1 Live demo through Claude Desktop

**Not yet run.** To do, with the token on, over the config in the README:

1. Ask what the fleet looks like (`get_fleet_status`), and confirm the
   `admin` field appears.
2. Send traffic through `POST /route`, then ask why one request went where it
   did (`explain_routing_decision`). The request id is now returned by
   `POST /route`, which closes the M5a follow-up.
3. Drain a replica from the chat, send more traffic, and ask why the next
   request did not use it. Expect "drained by operator".
4. Restore it, and change the strategy.
5. Confirm a wrong or missing token fails cleanly. Junaid's check of the
   `mcp-remote` bridge found that any 401 sends it into OAuth discovery and a
   registration attempt that our middleware also rejects, so it exits with
   `Dynamic Client Registration rejected (HTTP 401)` before any sign-in page
   opens. That was observed against the bridge, not in Claude Desktop itself;
   check what Claude Desktop shows, and that the correct token connects with
   no discovery requests after the first POST.

This is the PRD's demo sentence: ask why a request went where it did, then use
the same client to drain a struggling replica.

## 7. Known deferrals: carry into M6, do not fix now

1. **No history of operator actions** (4.1).
2. **Auth covers `/mcp` only** (4.2). Replica admin endpoints and the API
   server are unauthenticated; M8 puts them behind network policy.
3. **Token is one shared secret over plain HTTP.** No per-user identity, no
   rotation without a restart, readable on the network on a non-loopback bind.
   M8 (the ALB and TLS).
4. **`POST /route` error name for an all-drained fleet** (4.3).
5. **In-memory state** (4.4), plus the carried-over M5a items:
   `DecisionLog` and `FailoverLog` unbounded and in memory, fixed question
   shapes in `query_decisions`, linear scans, and a synchronous
   `RegistryStore`.
6. **`simulate_failure` has no `before`** (`changed: null`), by decision: no
   state-read endpoint was added to the replica.

## 8. M5b definition of done (from the task split)

- [ ] Exactly four read tools and five action tools are registered, and a test
  pins both sets (`test/mcp-tool-set.test.ts`; on `main` once #65 merges)
- [ ] No action tool is reachable without the auth gate, and the server
  refuses to expose them on a non-loopback bind without a token
  (`test/mcp-auth.test.ts`, `test/mcp-tool-set.test.ts`,
  `test/integration/m5b.test.ts`)
- [ ] `drain_replica` stops new traffic within 1s, in-flight requests are not
  cut off, the health scheduler does not undo it, and `restore_replica`
  returns the replica to the pool (integration test, scheduler test)
- [ ] `simulate_failure` injects a fault through the `FaultInjector`
  interface, leaving `ReplicaAdapter` at two functions, returns `unsupported`
  when no injector is wired, and the fleet fails over as in M3
- [ ] `set_routing_strategy` and `set_scoring_weights` change live routing,
  and invalid input is rejected without changing state
- [ ] Every action returns what actually changed, read back from the store,
  and a repeat or no-op call is `changed: false`, not a failure
- [ ] A decision made after a drain is explained as an operator action, never
  as a health problem
- [ ] PRD section 8 action reliability measured in
  `test/integration/m5b.test.ts` (section 6)
- [ ] Demoed live through Claude Desktop (section 6.1): **not yet run**
- [ ] README documents the action tools, the token, and the Claude Desktop
  config (this PR)
- [ ] Unit + integration tests green in CI
- [ ] Both authors have signed off (this document, section 9)

Boxes stay unchecked until #65, #67, and this PR are on `main` and CI is green
on them, so the checklist describes `main` and not a branch.

## 9. Sign-off

- [ ] Shared contract P1 to P4: agreed in
  `docs/milestones/m5b/shared-contract.md` (both, 2026-10-11)
- [ ] Drained state, engine pre-filter, explain wording, `drain_replica`,
  `restore_replica`, the `main.ts` wiring, and the integration test: built and
  self-reviewed (Arundhati, PRs #61, #62, #65, #67)
- [ ] Action envelope, auth, `set_routing_strategy`, `set_scoring_weights`,
  `simulate_failure` and the fault injector: built by Junaid (PRs #60, #63,
  #64, #66); read and checked against the contract by Arundhati, #63 re-run
  locally after the merge in 4.9
- [ ] **Junaid's review of this document**
- [ ] **Claude Desktop demo run** (section 6.1)

**M5b is not complete until the open boxes above are checked.**
