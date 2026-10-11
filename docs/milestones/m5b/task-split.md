# M5b Task Split: MCP Server, Action Tools

**Authors:** Arundhati Vasishth, Junaid Pathan
**Scope:** M5b only (PRD §5.6, §9): add the five write tools to the MCP server
M5a stood up: `drain_replica`, `restore_replica`, `simulate_failure`,
`set_routing_strategy`, `set_scoring_weights`. Every action must be reflected
in live fleet state within 1s (PRD §8, "MCP action reliability"), and every
action's result must say what actually changed, never what was merely asked
for. The dashboard is M6, out of scope here.
**Goal of this doc:** split M5b into two tracks of comparable weight, cut so
each person can build and test their track against a shared interface agreed
first, mirroring the [M1](../m1/task-split.md), [M2](../m2/task-split.md),
[M3](../m3/task-split.md), [M4](../m4/task-split.md), and
[M5a](../m5a/task-split.md) splits.

---

## 1. Principle

M5a exposed state. M5b lets a client change it, which is a different kind of
risk. A read tool that is wrong gives a wrong answer; an action tool that is
wrong takes a replica out of rotation or retunes live routing. Three things
in the current code make that concrete, and they set the shape of the split:

1. **Two of the five tools already have a home, two do not.**
   `RoutingConfig` already has `setStrategyName` and `setWeights` (M2, K10),
   and `setWeights` already rejects negative, `NaN`, and non-finite values.
   The simulated replica already has `POST /admin/kill`, `/admin/fail-infer`,
   and `/admin/revive` (M1, M3). Those three tools are thin wrappers. But
   **drain has no state to flip**: `ReplicaHealth` is
   `healthy | unhealthy | unknown`, the engine filters to `healthy`, and the
   health scheduler rewrites health on every probe. A drain written as a
   health value would be undone within one poll interval. Drain and restore
   are the one piece of new logic in M5b.
2. **The M5a deferral comes due.** `docs/architecture/m5a.md` §7.5 says `/mcp`
   has no authentication, which was fine for read-only tools and "has to be
   decided before any action tool is registered." That decision is the first
   gate of M5b.
3. **The read envelope does not fit writes.** M5a's `dispatch` turns a result
   with zero record ids into `no_data`, which is right for reads and wrong
   for an action ("drain replica-9" on an unknown id is an error, but "set
   strategy to the one already active" is a successful no-op). Actions need
   their own result shape that reports before and after.

The seam that divides the work evenly is **the new state model vs. the
action surface around it**:

- **Arundhati, Drain/Restore State track:** the part with no existing
  pattern. Give the system a drained state that the engine honors, the health
  scheduler does not overwrite, the decision log records as an exclusion
  reason, and `GET /status` and `get_fleet_status` show. Then the two tools
  that flip it, `drain_replica` and `restore_replica`. Direct continuation
  of the M3 ejection and M4 decision-log tracks (owns `src/registry/`,
  `src/routing/engine.ts` exclusion path, `src/decisions/`, and
  `src/mcp/tools/{drain-replica,restore-replica}.ts`).
- **Junaid, Action Surface track:** the gate and the plumbing every action
  goes through: the `/mcp` authentication decision and its implementation,
  the action result envelope, and registering write tools beside the read
  tools. Then the three tools that wrap existing mechanisms:
  `simulate_failure`, `set_routing_strategy`, `set_scoring_weights`. Direct
  continuation of the M5a server scaffold and the M2 routing-config track
  (owns `src/mcp/server.ts`, `src/mcp/action.ts`, `src/mcp/auth.ts`, and
  `src/mcp/tools/{simulate-failure,set-routing-strategy,set-scoring-weights}.ts`).

### The two hard design questions

**P1: how is "drained" represented?** Options:

- (a) A new `ReplicaHealth` value, `"draining"`. Smallest diff, but the
  scheduler writes `health` on every probe and its hysteresis would race the
  drain. Rejected unless the scheduler is changed to skip drained replicas,
  which spreads the change into M1 code.
- (b) A separate `admin` field on `ReplicaRuntime` (`"active" | "drained"`),
  owned by the registry and never written by the scheduler. Health stays a
  statement about the replica's own condition; drain is an operator decision.
  The engine excludes `drained` replicas with a distinct exclusion reason.
  **Leading answer**, because it keeps "is it broken" and "did an operator
  take it out" as two facts, and the explainability story (PRD §8) needs to
  say which one excluded a replica.

Also settle what "gracefully" means in PRD §5.6: stop routing *new* traffic,
let in-flight requests finish. Because the engine only decides at pick time,
this falls out of (b) for free and needs no connection tracking. Confirm that
in the contract rather than assume it.

**P2: what authenticates `/mcp`?** Options: a shared bearer token from
`WR_MCP_TOKEN`, required on every call, or required only for the five action
tools while reads stay open. Leading answer: one bearer token, required for
the whole endpoint when set, and the server **refuses to register action tools
if the endpoint is bound to a non-loopback host with no token**. That keeps
the local demo one env var away from working and makes the unsafe
configuration impossible rather than documented. Real identity (per-user
auth, audit by user) is M8 with the ALB and stays out of scope.

---

## 2. Shared contract (design together first, ~45 min, before any code)

Agree on and commit these before splitting off. Junaid drafts P2 and P3,
Arundhati drafts P1 and P4, both review the whole thing.

| Item | File | Notes |
|---|---|---|
| **P1** Drained-state representation | `docs/decisions.md`, `src/registry/types.ts` (signature only) | Resolves the question above. Includes the registry method (`setAdmin(id, state)` or similar), whether the field is on `ReplicaRuntime` or beside it, the new engine `excluded` reason string, and what `/status` shows. |
| **P2** `/mcp` authentication | `docs/decisions.md`, `src/mcp/auth.ts` (signature only) | Bearer token via `WR_MCP_TOKEN`, the refuse-to-start rule for non-loopback with no token, and what an unauthenticated call returns. Supersedes nothing; resolves M5a deferral 5. |
| **P3** Action result envelope | `src/mcp/action.ts` (design here) | One shape for all five tools. Something like `ActionResult = { ok: true; changed: boolean; before: S; after: S; appliedAt: string } \| { ok: false; code: "unknown_replica" \| "invalid_input" \| "unauthorized" \| "unsupported" \| "internal_error"; reason: string }`. `changed: false` is a success (draining an already-drained replica, setting the active strategy). `before` and `after` are read back from the store after the write, not echoed from the arguments, which is what makes PRD §8's "correctly reflected in live fleet state" checkable. |
| **P4** `simulate_failure` semantics | `src/mcp/tools/simulate-failure.ts`, `src/replica/fault-injector.ts` (signatures only) | Which fault the tool triggers: `/admin/kill` (health fails, scheduler ejects), `/admin/fail-infer` (only requests fail, request-driven ejection), or a `mode` argument choosing between them. Also: is there a way to undo it from MCP (`/admin/revive`), or does `restore_replica` cover it. **Where the call lives:** not on `ReplicaAdapter`. `docs/decisions.md` (2026-09-01) fixes that boundary at exactly two functions, and a kill switch only exists on simulated replicas (a real Ollama or vLLM replica has none), so a third adapter method would break the Phase 2 swap. Instead a separate `FaultInjector` interface (`inject(replicaId, mode)` and `clear(replicaId)`), implemented only by the simulated fleet in `src/replica/`. The tool takes an optional `FaultInjector`; when none is wired it returns `unsupported` with a reason, rather than failing or silently doing nothing. |

Also agree: the argument shape of `set_scoring_weights(load_weight,
latency_weight)` against `ScoringWeights` field names, and whether the two
weights must sum to 1 or are free positive numbers (the code today only
rejects negative and non-finite, so adding a sum rule would be a behaviour
change to M2 and should be a deliberate call).

### Frozen by this contract (do not change in M5b)

The four M5a read tools and their `dispatch` envelope do not change. M5b adds
a second envelope beside it, it does not widen `ToolResult`. The routing
strategies' `pick` and `score` signatures do not change; drain is enforced
in the engine's pre-filter, where `unhealthy` already is, so no strategy sees
a drained replica. `RegistryStore` stays synchronous (Redis is still M7/M8). `ReplicaAdapter`
stays exactly two functions (`docs/decisions.md`, 2026-09-01); fault injection
is a separate interface, see P4.

---

## 3. Arundhati: Drain/Restore State track

| # | Task | Deliverable |
|---|---|---|
| P5 | **Drained state in the registry** | Implement P1 in `src/registry/registry.ts` (and the Redis stub's signature in `redis.ts`): new field, setter, and its appearance in `getSnapshot()`. The health scheduler is not touched; a test proves a probe cycle leaves a drained replica drained. |
| P6 | **Engine honors drain** | `src/routing/engine.ts` pre-filter excludes drained replicas with the P1 reason, ahead of strategies. A drained but healthy replica is `excluded`, not a candidate. If every healthy replica is drained, the existing `no_healthy_replicas` path fires and its `excluded` list says why. |
| P7 | **Decision log and explain wording** | The new exclusion reason flows into `DecisionRound.excluded` unchanged, and `explain_routing_decision` words it as an operator action, not a fault ("drained by operator" versus "unhealthy"). This is the PRD §8 explainability metric applied to the new state: no decision after a drain may be explained as a health problem. `ExcludedCandidate`'s reason is a closed union of `unhealthy` and `already_tried` (M4 contract, N3), so adding the drain reason widens that type: the same PR updates `docs/milestones/m4/shared-contract.md` N3 and the explain wording tests. |
| P8 | **`drain_replica(replica_id)`** | `src/mcp/tools/drain-replica.ts`: validates the id, flips the state through P5, reads the replica back, returns the P3 envelope. Unknown id is `unknown_replica`. Already drained is `changed: false`. Refuses to drain the last non-drained healthy replica? Settle in P1: the leading answer is **allow it** (the operator asked, and `no_healthy_replicas` is an honest outcome), with the `after` payload carrying how many replicas remain routable so the client can warn. |
| P9 | **`restore_replica(replica_id)`** | `src/mcp/tools/restore-replica.ts`: the inverse. Restoring a drained-but-unhealthy replica returns it to `active` and the result says it is still not routable because of health, rather than implying it is back in rotation. |
| P10 | **Unit tests** | registry setter and snapshot; scheduler does not overwrite; engine excludes drained and reports it; decision log records the reason; explain wording; both tools for known id, unknown id, repeat call, and drained-plus-unhealthy. |

---

## 4. Junaid: Action Surface track

| # | Task | Deliverable |
|---|---|---|
| P11 | **`/mcp` authentication** | `src/mcp/auth.ts` and `WR_MCP_TOKEN` in `src/config.ts`: implement P2. Constant-time token compare, 401 on missing or wrong token, and the startup refusal for action tools on a non-loopback bind with no token. Config tests alongside the existing `config.test.ts` pattern. Also check early, before P20, that the `mcp-remote` bridge Claude Desktop uses can send the token as an `Authorization` header, since that is the demo path; if it cannot, the auth design has to change before it is built, not after. |
| P12 | **Action envelope and registration** | `src/mcp/action.ts`: implement P3 as `defineActionTool` beside M5a's `defineTool`, with the same never-rejects guarantee (a throw becomes `internal_error`, the server stays up). `server.ts` registers action tools through it. M5a's rule that the read set is exactly four tools becomes: the read set is still four, the action set is exactly five, and a test pins both. |
| P13 | **`set_routing_strategy(strategy)`** | `src/mcp/tools/set-routing-strategy.ts`: validates against `STRATEGY_NAMES`, calls `RoutingConfig.setStrategyName`, returns before and after read back from the config. Lists the valid names when it rejects one, as M5a's `query_decisions` does. |
| P14 | **`set_scoring_weights(load_weight, latency_weight)`** | `src/mcp/tools/set-scoring-weights.ts`: maps to `ScoringWeights`, surfaces `setWeights`' rejection of negative and non-finite values as `invalid_input` rather than `internal_error`. Notes in the result when the active strategy ignores weights (round-robin), so a successful call is not mistaken for an effective one. |
| P15 | **`simulate_failure(replica_id)`** | `src/mcp/tools/simulate-failure.ts` and `src/replica/fault-injector.ts`: per P4, implement the `FaultInjector` for the simulated fleet (it calls the replica's admin endpoints) and have the tool use it. `ReplicaAdapter` is not touched, and MCP code never calls a replica URL directly. Returns which fault was injected, and `unsupported` when no injector is wired. |
| P16 | **Unit tests** | auth (missing, wrong, right token; the startup refusal); envelope never rejects; the exact-five and exact-four registration test; each of the three tools for the valid case, invalid input, and a no-op repeat. |

---

## 5. Joint tasks

| # | Task | Split |
|---|---|---|
| P17 | **Shared contract doc** in `docs/milestones/m5b/shared-contract.md`: P1 through P4 written up the way M5a's was, plus the `docs/decisions.md` entries for drained-state representation and `/mcp` authentication. | pair, Junaid drafts P2/P3, Arundhati drafts P1/P4 |
| P18 | **Main wiring** in `src/main.ts`: build the action tools from the same registry, routing config, and adapter instances the API server holds, behind the P11 auth gate. Small diff on top of M5a's wiring. | whoever finishes their track first drafts, other reviews |
| P19 | **Integration test** `test/integration/m5b.test.ts`, in the shape of M5a's: a real MCP client over HTTP drives each action against a live fleet and asserts the effect through `get_fleet_status` and `POST /route` within 1s. This is the measured form of PRD §8's action-reliability metric (100% of drain, restore, strategy-change calls reflected in live state within 1s), not just asserted. Includes the cross-track cases: drain a replica, route N requests, none land on it, `explain_routing_decision` on one of them cites the drain; simulate failure, confirm failover; restore. | pair |
| P20 | **MCP client demo**: connect Claude Desktop with the token, run the PRD §3 demo sentence end to end (ask why a request went where it did, then drain a struggling replica) through a real client. Record it in the review as M5a did. | pair |
| P21 | **M5b architecture review + README update** in `docs/architecture/m5b.md`, same shape as [`m5a.md`](../../architecture/m5a.md): confirm no dashboard (M6) concern leaked in, confirm the read tools are untouched, confirm no action is reachable without the auth gate, report the two design decisions and why, both sign off. README gains the token setup and the five tools. | both |

Everything else, P5 to P10 and P11 to P16, is single-owner. The real
cross-track dependency is P3: Arundhati's P8 and P9 return Junaid's envelope,
so P3's shape has to be agreed (not built) before either starts, and P12 has
to land before P8 can be registered. The second is P19, which needs both
tracks merged.

---

## 6. Sequencing

1. **Day 1:** P17 shared contract (together, ~45 min); settle P1 and P2
   before any code, since both change what gets built.
2. **Day 1-2:** Junaid P12 (envelope and registration) and P11 (auth);
   Arundhati P5 and P6 (drained state, engine), in parallel. P12 lands first
   on the shared side because P8 and P9 need it to register.
3. **Day 2-3:** Junaid P13 to P15; Arundhati P7 to P9.
4. **Day 3-4:** tests, P16 and P10.
5. **Day 4:** P18 wiring.
6. **Day 4-5:** P19 integration test, then P20 demo.
7. **Day 5:** P21 review and sign-off.

---

## 7. Effort balance check

| | Arundhati | Junaid |
|---|---|---|
| Shared design authoring | P1 drained state + P4 `simulate_failure` semantics | P2 auth + P3 action envelope |
| Large module | Drained state through registry, engine, decision log, explain (P5 to P7) | Auth plus action envelope and registration (P11, P12) |
| Medium module | `drain_replica` + `restore_replica` (P8, P9) | `simulate_failure` through a fault-injection interface (P15) |
| Small module | (none) | `set_routing_strategy` + `set_scoring_weights` (P13, P14) |
| Tests | own modules (P10) | own modules (P16) |
| Joint | P17 to P21, split evenly | same |

Arundhati's track is one cross-cutting change that touches four existing
modules, so it carries the regression risk. Junaid's track is wider and
shallower: two new files of infrastructure plus three tools, two of which are
thin wrappers over setters that already exist. Weighted that way the two sides
are close; if P11 turns out heavier than expected (the non-loopback refusal
rule), P14 is the item to hand across.

---

## 8. Working agreement

The commit / branch / PR / review rules live in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
at the repo root. They are project-wide, not M5b-specific. In force for all
of M5b.

---

## 9. Definition of done (M5b)

- Exactly four read tools and five action tools are registered, and a test
  pins both sets.
- No action tool is reachable without the P2 gate, and the server refuses to
  expose them on a non-loopback bind without a token.
- `drain_replica` stops new traffic to a replica within 1s, in-flight
  requests are not cut off, the health scheduler does not undo it, and
  `restore_replica` returns the replica to the pool.
- `simulate_failure` injects a fault through the `FaultInjector` interface,
  leaving `ReplicaAdapter` at two functions, returns `unsupported` when no
  injector is wired, and the
  fleet fails over as in M3.
- `set_routing_strategy` and `set_scoring_weights` change live routing, and
  invalid input is rejected without changing state.
- Every action returns what actually changed, read back from the store, and
  a repeat or no-op call is reported as `changed: false`, not as a failure.
- A routing decision made after a drain is explained as an operator action,
  never as a health problem (PRD §8 explainability, extended).
- PRD §8 action reliability is measured in `test/integration/m5b.test.ts`:
  100% of drain, restore, and strategy-change calls reflected in live fleet
  state within 1s.
- Demoed live through an actual MCP client (Claude Desktop), not only through
  unit tests calling tool functions directly.
- Unit + integration tests green in CI.
- Both authors have signed off in M5b's architecture review (P21).
