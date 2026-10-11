# M5b Shared Contract (P1 to P4)

**Status:** half drafted. Arundhati drafted P1 and P4 below; Junaid reviews
them. Junaid's P2 and P3 are to-do lists in their marked sections, to be
replaced with the agreed text, and Arundhati reviews those. P5 onward build against this doc once both halves are signed off.
**Covers:** how a drained replica is represented (P1), `/mcp` authentication
(P2), the action result envelope (P3), and `simulate_failure` semantics (P4).
See [`task-split.md`](task-split.md) for why these four come first.

Landed / to land as:
- P1: `docs/decisions.md` (entry added with the P5 PR), `src/types.ts`,
  `src/registry/` (P5), `src/routing/types.ts` and `engine.ts` (P6)
- P2: `docs/decisions.md`, `src/mcp/auth.ts` (Junaid)
- P3: `src/mcp/action.ts` (Junaid)
- P4: `src/mcp/tools/simulate-failure.ts`, `src/replica/fault-injector.ts`
  (signatures only here)

Any change after sign-off goes through a PR that updates this doc and the
affected files together.

---

## P1: Drained-state representation

**Decided (leading answer, pending Junaid's review): a separate `admin` field
on `ReplicaState`, beside `runtime`, not a new health value.**

```ts
// src/types.ts
export type ReplicaAdmin = "active" | "drained";

export interface ReplicaState extends Replica {
  runtime: ReplicaRuntime;
  /** Operator intent. Set only through the registry's `setAdmin`; the health
   *  scheduler cannot reach it. */
  admin: ReplicaAdmin;
}
```

`register()` starts every replica `"active"`. `GET /status` and
`get_fleet_status` show `admin` on each replica, which is an additive change
to the M1 `/status` shape.

### Why beside `runtime`, not inside it

The scheduler writes through `HealthSink = Pick<RegistryStore,
"updateRuntime" | "setHealth">`, and `updateRuntime` takes
`Partial<ReplicaRuntime>`. Putting `admin` on `ReplicaState` means the
scheduler cannot write it at the type level, with no code change to the
scheduler and no reliance on a comment saying "do not touch this." A new
health value (`"draining"`) was rejected: `setHealth` runs on every hysteresis
transition and request-driven ejection (`scheduler.ts:142`) and would
overwrite it within one poll interval.

It also keeps two facts separate that the explainability metric needs
separate: "the replica is broken" and "an operator took it out."

### Registry interface

```ts
// src/registry/types.ts (added to RegistryStore)
setAdmin(id: string, admin: ReplicaAdmin): void; // throws on an unknown id, like setHealth
```

`HealthSink` is unchanged, so the scheduler still cannot call it. The Redis
stub's signature gets the same method and still throws. `getSnapshot()` copies
`admin` per replica like it copies `runtime`.

### Engine behaviour

`route()` excludes drained replicas in the same pre-filter that excludes
unhealthy ones, so no strategy ever sees one (the M5b frozen rule).

```ts
// src/routing/types.ts
export interface ExcludedCandidate {
  replicaId: string;
  reason: "unhealthy" | "already_tried" | "drained"; // "drained" is new
}
```

- A replica that is both drained and unhealthy is reported as **`drained`**.
  The operator's action is the more specific cause, and fixing its health
  would not return it to rotation. This is a deliberate choice, not an
  accident of check order, and the engine test pins it.
- Drained replicas are removed before the `healthy.length === 0` check, so
  draining every healthy replica takes the existing `no_healthy_replicas`
  path with each drained replica listed in `excluded`. The error name stays
  as is: renaming it would change the M2 contract and the `/route` response
  for a wording gain.
- Drained replicas are never in `candidates`, same as unhealthy ones.

### "Gracefully" (PRD §5.6)

Drain stops **new** traffic only. The engine decides at pick time, so a
request already sent to the replica is untouched and finishes normally. No
connection tracking is needed, and none is added. One consequence to state
rather than hide: a retry loop that already picked a drained replica for an
in-progress request is not interrupted either; its *next* pick excludes it.

### Draining the last routable replica

**Allowed.** The operator asked, and `no_healthy_replicas` is an honest
outcome. The `drain_replica` result reports how many replicas remain
routable after the change (see P8 in the task split) so the client can warn,
and the tool does not refuse.

### Restoring an unhealthy replica

`restore_replica` sets `admin` back to `"active"` and nothing else. If the
replica is also unhealthy it is still not routable, and the result says so
(`after` carries both `admin` and `health`) rather than implying it is back
in rotation.

### Explainability

`explain_routing_decision` words `drained` as an operator action ("drained by
operator"), never as a health fault. This widens an M4 type, so the P7 PR
also updates `docs/milestones/m4/shared-contract.md` N3 and the explain
wording tests. `Decision`'s own shape does not change.

### Not in M5b

Drain state is in-memory like the registry. A restart returns every replica
to `active`. That is the same limit the M5a review recorded for the logs, and
persistence waits for the Redis-backed store (M7/M8).

---

## P2: `/mcp` authentication

*Junaid to write. Use the same layout as M5a's O3 and O4: the call, the
shape, the rules, an example. Leading answer from the task split: one bearer
token from `WR_MCP_TOKEN`, and the server refuses to register action tools on
a non-loopback bind with no token. Confirm or change each of these, and write
the answer down:*

1. **Do this check first, before writing the rest.** Claude Desktop reaches
   the server through the `mcp-remote` bridge. Can it send an `Authorization:
   Bearer` header (a `--header` flag or an env var)? Record what you found and
   the exact config the demo will use. If it cannot, this whole section
   changes, so say so here before P11 starts.
2. **Scope of the token.** Required on every call to `/mcp`, or only on the
   five action tools with reads staying open? Leading answer: the whole
   endpoint when `WR_MCP_TOKEN` is set. One rule is easier to explain than
   two, and the read tools expose request ids and replica URLs.
3. **When no token is set.** Loopback bind (the default `127.0.0.1`): all nine
   tools work, as in M5a, so the local demo is one env var away from secure
   and zero away from working. Non-loopback bind: action tools are not
   registered at all, and the startup log says why. State the exact test for
   "loopback" (`127.0.0.1`, `::1`, `localhost`) and what happens for
   `0.0.0.0`.
4. **What an unauthenticated call returns.** HTTP 401 at the transport, before
   MCP parsing, or an MCP-level error? State the status, body, and whether the
   response says "missing" versus "wrong" (leading answer: it does not
   distinguish).
5. **Mechanics.** Constant-time compare, where the token is read (`Config`
   field name, how `loadConfig` validates it, empty string treated as unset),
   and that it is never logged, including in the startup banner.
6. **What this does not cover.** Per-user identity and audit by user are M8
   (ALB). Say so, so nobody reads this as an audit trail.

*Sources: `src/mcp/server.ts` (the Express app at `app.listen`),
`src/config.ts` (`host`, `mcpPort`), `docs/architecture/m5a.md` §7 item 5.*

---

## P3: Action result envelope

*Junaid to write, same layout. P8, P9, P13, P14, and P15 all return this, so
it has to be agreed before any of them starts. Start from this sketch and fix
whatever is wrong:*

```ts
// src/mcp/action.ts
export type ActionFailureCode =
  | "unknown_replica"
  | "invalid_input"
  | "unauthorized"
  | "unsupported"
  | "internal_error";

export type ActionResult<S> =
  | { ok: true; changed: boolean; before?: S; after: S; appliedAt: string }
  | { ok: false; code: ActionFailureCode; reason: string };
```

*Decide and write down:*

1. **`before` and `after` come from the store.** `after` is read back after
   the write, never echoed from the arguments. This is what makes PRD §8's
   "reflected in live fleet state" checkable. Is `before` required or
   optional? **Needed for P4:** `simulate_failure` has no way to read a
   replica's fault state before the call, so I propose `before` is optional on
   that tool only (see the open question in P4). Your call, but P4 depends on
   it.
2. **`changed: false` is a success.** Confirm for: draining a drained replica,
   restoring an active one, setting the strategy already active, setting the
   same weights.
3. **What `S` is per tool.** One line each: drain and restore (`admin`,
   `health`, and routable count, from P1), strategy (`{ strategy }`), weights
   (`{ load, latency }` plus whether the active strategy uses them), fault
   (`FaultState`).
4. **`appliedAt`.** Stamped by the wrapper after the write, like M5a's
   `queriedAt`, with an injectable clock for tests.
5. **Never rejects.** A throw becomes `internal_error` and the server stays
   up, as M5a's `dispatch` does. Also decide whether `defineActionTool` wraps
   `dispatch` or stands beside it. The split says beside it; the read tools
   must not change.
6. **Mapping to MCP.** M5a's `toCallToolResult` (`server.ts`) sets `isError`
   for `invalid_input` and `internal_error` only, so `no_data` is not an
   error. For actions, a failed action is a failed action: decide which codes
   set `isError` (leading answer: all of them), and whether `unauthorized`
   ever reaches here given P2 rejects at the transport. Write the mapping as a
   table.
7. **Registration.** How `server.ts` accepts action tools beside read tools,
   and the exact-nine pin (four read, five action) the split calls for.

*Sources: `src/mcp/types.ts` (`dispatch`), `src/mcp/server.ts`
(`defineTool`, `toCallToolResult`), `docs/architecture/m5a.md` §7.*

---

## P4: `simulate_failure` semantics

### The call

```ts
// src/mcp/tools/simulate-failure.ts
inputSchema: {
  replica_id: string,
  mode?: "kill" | "fail_infer" | "revive", // default "kill"
}
```

- `kill` calls `POST /admin/kill`: every request including `/health` fails, so
  the health scheduler ejects the replica after its hysteresis (3 failed
  probes, about 1.5 seconds at the 500ms default). This is PRD's "controlled
  crash."
- `fail_infer` calls `POST /admin/fail-infer`: only `/infer` fails with 503,
  `/health` stays fine, so ejection is request-driven (M3). Useful for
  showing failover without the health path also reacting.
- `revive` calls `POST /admin/revive`: clears either fault. **The tool count
  stays five.** An extra `revive_failure` tool would break the pinned
  four-plus-five registration, and the mode is the same mechanism.

**`restore_replica` does not clear a fault.** It only clears the drain (P1).
Restoring a replica whose process is still killed leaves it unhealthy, and
that result already says so. Undoing a simulated failure is `mode: "revive"`.

### Where the call lives

Not on `ReplicaAdapter`, which `docs/decisions.md` (2026-09-01) fixes at two
functions. A separate interface, implemented only by the simulated fleet:

```ts
// src/replica/fault-injector.ts
export type FaultMode = "kill" | "fail_infer" | "revive";

export interface FaultState {
  killed: boolean;
  inferFailing: boolean;
}

export interface FaultInjector {
  /** Applies the mode and returns the replica's own report of its fault state. */
  inject(replicaId: string, mode: FaultMode): Promise<FaultState>;
}
```

`FaultState` is exactly the `{ killed, inferFailing }` body the replica admin
endpoints already return, so the implementation maps ids to the replicas'
URLs and forwards the response. It does not invent state.

The tool takes an optional `FaultInjector`. When none is wired (a Phase 2
fleet of real replicas) it returns `unsupported` with a reason, never `ok`
and never a silent no-op.

### What the result says

Under P3's envelope, for `simulate_failure`:

- `after` is the `FaultState` the replica reported, read back from the
  replica rather than assumed from the mode. `before` is not available
  without a second call, so it is omitted for this tool rather than guessed.
- `changed` is `false` when the reported state equals what the replica
  already had, which needs one read before the write. If the replica has no
  state-read endpoint, `revive` on a healthy replica still reports
  honestly from the admin response. **Open question for Junaid:** whether
  P3 allows `before` to be optional on this one tool, or whether a read-only
  `GET /admin/state` is added to the simulated replica so `before` is real.
  I lean toward optional `before`, because adding a replica endpoint widens
  the M1 HTTP surface for a field no client needs.
- The result does **not** claim the replica is now unhealthy. A kill takes
  about 1.5 seconds to show in the registry. The result says the fault was
  injected and points at `get_fleet_status` for the health effect. This is
  also why PRD §8's "reflected within 1s" metric covers drain, restore, and
  strategy changes, and not the health consequence of `simulate_failure`.

### Errors

- Unknown `replica_id`: `unknown_replica`, checked against the registry
  before any network call.
- Bad `mode`: `invalid_input`, listing the three valid modes.
- No injector wired: `unsupported`.
- The replica's admin endpoint unreachable (already dead process): reported
  as `internal_error` with the connection reason, since "kill a replica that
  is already down" has no state to read back.

---

## Frozen by this contract

- **The four M5a read tools and `dispatch`.** Unchanged.
- **`ReplicaAdapter`:** exactly two functions.
- **Strategy `pick` and `score` signatures.** Drain is enforced in the
  engine's pre-filter.
- **The replica HTTP admin surface** (`/admin/kill`, `/fail-infer`,
  `/revive`). `FaultInjector` wraps it; it does not add endpoints.
- **`RegistryStore` stays synchronous.**

## Not frozen

- **Wording of the drain explanation** in `explain_routing_decision`. The
  `cites` rule from M5a stays.
- **The default fault mode.** `kill` matches the PRD's wording; changing it is
  additive.

---

## Sign-off checklist

Arundhati's items (Junaid to review):
- [ ] P1: `admin` on `ReplicaState`, not a health value; `setAdmin` on
      `RegistryStore` only, `HealthSink` unchanged.
- [ ] P1: `drained` wins over `unhealthy` in the engine's `excluded` reason.
- [ ] P1: draining the last routable replica is allowed and reported.
- [ ] P4: three modes on one tool, `revive` clears faults, `restore_replica`
      does not.
- [ ] P4: `FaultInjector` off the adapter, `unsupported` when unwired.
- [ ] P4: open question on optional `before` for this tool.

Junaid's items (Arundhati to review):
- [ ] P2: `/mcp` authentication.
- [ ] P3: action result envelope.
