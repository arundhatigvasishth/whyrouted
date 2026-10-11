# M5b Shared Contract (P1 to P4)

**Status:** drafted. Arundhati drafted P1 and P4; Junaid drafted P2 and P3
and reviews P1 and P4. Each half still needs the other's review before the
boxes at the bottom are checked. P5 onward build against this doc once both
halves are signed off.
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

### The check that decided the design

Claude Desktop reaches the server through the `mcp-remote` bridge, so the
token has to travel through it. Checked on 2026-10-11 by pointing the bridge
at a stand-in server that records request headers:

- `--header "Authorization: Bearer abc123"` arrives as `Authorization: Bearer
  abc123` on the POST.
- `--header "Authorization:${VAR}"`, with `VAR` set in the bridge's
  environment to `Bearer <token>`, also arrives intact. This is the form the
  demo uses, because a space inside a command-line argument is fragile in
  Windows config files and the token stays out of the args list.

So bearer auth works with the demo path and the design stands. The config the
demo will use:

```json
{
  "mcpServers": {
    "whyrouted": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8090/mcp",
        "--allow-http",
        "--header",
        "Authorization:${WHYROUTED_AUTH}"
      ],
      "env": { "WHYROUTED_AUTH": "Bearer <the WR_MCP_TOKEN value>" }
    }
  }
}
```

### What a 401 does to the bridge

The bridge sends two probe requests with no `Authorization` header at startup
(`/.well-known/openid-configuration/mcp` and
`/mcp/.well-known/openid-configuration`). Separately, it was tested against a
server that answers **every** request with 401, once with and once without a
`WWW-Authenticate: Bearer` header, using a wrong token:

- **The header is not the trigger.** Both runs behaved identically. Any 401 on
  `POST /mcp` sends the bridge into OAuth discovery: it requests
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
  and `/.well-known/openid-configuration`, starts a local callback server,
  then tries dynamic client registration with `POST /register`.
- **With this server it ends cleanly.** Our middleware answers all of those
  with 401 too, so registration is rejected and the bridge exits with
  `Dynamic Client Registration rejected (HTTP 401)`. The flow stops at
  registration, before any sign-in page would be opened. (This was observed,
  not read from the bridge's source.)
- **So the header stays.** `WWW-Authenticate: Bearer` is the correct 401 for a
  bearer endpoint, and dropping it changes nothing for this client.

What this means for a person using it: a wrong or missing token shows up in
Claude Desktop as a failed server with that registration error in its log,
not as a prompt. The README's token setup should say so, because it is not an
obvious message. P11 still tests the happy path against the real middleware
(correct token connects, no discovery requests follow the first POST).

### The call

**One bearer token, `WR_MCP_TOKEN`, required on every request to `/mcp` when
it is set.** Not only on the five action tools. One rule is easier to explain
than two, and the read tools expose request ids and replica URLs.

```ts
// src/mcp/auth.ts
import type { RequestHandler } from "express";

/** True for `127.0.0.1`, `::1`, and `localhost` (trimmed, case-insensitive). */
export function isLoopbackHost(host: string): boolean;

/** `Authorization: Bearer <token>` against the configured token, in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean;

/** Express middleware: 401 unless the request carries the token. */
export function createAuthMiddleware(token: string): RequestHandler;

export type ActionPolicy = { allowed: true } | { allowed: false; reason: string };

/** Whether the five action tools may be registered for this bind and token. */
export function actionToolsAllowed(opts: {
  host: string;
  token: string | undefined;
}): ActionPolicy;
```

### Rules

- **Token set:** every request to `/mcp` must carry it, on any bind, and all
  nine tools are registered. The middleware runs before body parsing and
  before the 405 handlers, so `GET` and `DELETE` are also rejected with 401
  without the token, not told 405.
- **No token, loopback bind** (`127.0.0.1`, `::1`, `localhost`, the default):
  nothing is required and all nine tools work. The local demo is one env var
  from secure and zero from working.
- **No token, any other bind** (`0.0.0.0`, `::`, a LAN address, any other
  name): the four read tools stay as they were in M5a, the five **action tools
  are not registered at all**, and startup logs one line saying why and how to
  fix it ("set WR_MCP_TOKEN"). They are absent from `tools/list`, not present
  and rejecting, so there is nothing to call. The unsafe configuration is
  impossible, not documented.
- **What an unauthenticated call gets:** HTTP `401`, header
  `WWW-Authenticate: Bearer`, body `{ "error": "unauthorized" }`, returned at
  the transport before any MCP parsing. A missing token and a wrong token get
  the identical response, so the endpoint does not confirm which was wrong.
- **Scheme parsing:** `Bearer` is matched case-insensitively followed by one
  space and the token. Anything else (`Basic`, no space, empty) is a wrong
  token.

### Mechanics

- **Config:** `Config.mcpToken: string | undefined`, read from
  `WR_MCP_TOKEN`. Empty or whitespace-only is treated as unset. A token
  shorter than 16 characters is rejected by `loadConfig` with the other
  validation errors, so a one-character "token" cannot be set by accident.
- **Constant time:** both sides are hashed with SHA-256 and the digests
  compared with `crypto.timingSafeEqual`. Hashing first means the compare
  never throws on a length mismatch and does not leak the token's length.
- **Never logged.** Not in the startup banner, not in errors, not in the 401
  body. The banner says `auth: token required` or `auth: none (loopback
  only)`, nothing more.
- **Wiring:** `startMcpServer` takes an optional `token`. When given, the
  middleware is installed first in `createMcpApp`. `main.ts` calls
  `actionToolsAllowed` and registers the action tools only when it returns
  `allowed: true`.

### What this does not cover

Per-user identity and audit by user are M8 (the ALB). The token is one shared
secret: it says "someone with the token", not who, so this is **not an audit
trail**. It is also plain HTTP, so a token sent over a non-loopback bind is
readable on the network until M8 puts TLS in front. Rotating the token means
restarting. None of that is a gap for the localhost demo, and the section
exists so nobody reads this as more than it is.

_Sources: `src/mcp/server.ts` (`createMcpApp`, `startMcpServer`),
`src/config.ts` (`host`, `mcpPort`), `docs/architecture/m5a.md` §7 item 5._

---

## P3: Action result envelope

### The call

Actions get their own envelope, `ActionResult`, beside M5a's `ToolResult`.
The read envelope does not fit: it turns a result with zero records into
`no_data`, which is right for a read and wrong for an action. `dispatch` and
`defineTool` do not change.

```ts
// src/mcp/action.ts
export type ActionFailureCode =
  | "unknown_replica"
  | "invalid_input"
  | "unsupported"
  | "internal_error";

export type ActionResult<S> =
  | {
      ok: true;
      /** true or false when `before` is present; null when it is not. */
      changed: boolean | null;
      before?: S;
      after: S;
      /** ISO 8601. Stamped by the wrapper after the write, never by a tool. */
      appliedAt: string;
      /** Advisories the client should see, e.g. "this strategy ignores weights". */
      notes?: string[];
    }
  | { ok: false; code: ActionFailureCode; reason: string };

/** What an action handler returns. It never builds an ActionResult itself. */
export type ActionOutput<S> =
  | { kind: "applied"; before?: S; after: S; notes?: string[] }
  | { kind: "unknown_replica" | "invalid_input" | "unsupported"; reason: string };

export type ActionHandler<A, S> = (args: A) => ActionOutput<S> | Promise<ActionOutput<S>>;

export interface ActionOptions {
  /** Clock for `appliedAt`. Defaults to `() => new Date()`. Tests inject one. */
  now?: () => Date;
}

/** Wrap a handler so every call returns an ActionResult and never rejects. */
export function performAction<A, S>(
  handler: ActionHandler<A, S>,
  opts?: ActionOptions,
): (args: A) => Promise<ActionResult<S>>;
```

### Rules the wrapper enforces, once, for every action

- **`after` is read back, not echoed.** A handler writes, then reads the
  store (registry or routing config) and returns what it read. It never
  returns the arguments it was given. This is what makes PRD §8's "reflected
  in live fleet state" checkable, and the integration test asserts it through
  `get_fleet_status`, not through the action's own answer.
- **`changed` is derived, not claimed.** When `before` is present the wrapper
  sets `changed` to whether `before` and `after` differ (deep equality), so a
  tool cannot report a change that did not happen or hide one that did.
- **`before` is required for four tools and optional for one.** Drain,
  restore, set strategy, and set weights always return `before`, read from
  the store before the write; a test pins this. `simulate_failure` is the one
  exception: a replica has no state-read endpoint and the admin surface is
  frozen, so there is no honest prior state to read (answering P4's open
  question: **optional `before` on that tool only, no `GET /admin/state`**).
  For it `changed` is **`null`**, meaning "cannot tell", never a guess.
- **`changed: false` is a success.** Draining a drained replica, restoring an
  active one, setting the strategy already active, and setting the same
  weights are all `ok: true` with `changed: false`. A repeat call is not an
  error and does not reach `internal_error`.
- **A failed action changed nothing.** `unknown_replica`, `invalid_input`,
  and `unsupported` are decided before any write. Invalid input leaves the
  store exactly as it was, and each tool's tests assert that.
- **`appliedAt` is stamped by the wrapper** after the handler returns, like
  M5a's `queriedAt`, with an injectable clock.
- **Never rejects.** A throw, sync or async, becomes `internal_error` with the
  message as `reason`, and the server stays up.
- **No `unauthorized` code.** The task split's sketch listed one, but
  authentication is rejected at the transport (P2) before any tool runs, so no
  action handler can ever produce it. A code nothing emits invites dead
  branches, so it is not in the type.

### What `S` is per tool

| Tool | `S` | Notes |
|---|---|---|
| `drain_replica`, `restore_replica` | `{ replicaId, admin, health, routable, routableReplicas }` | `routable` is `admin === "active" && health === "healthy"`. `routableReplicas` is how many replicas are routable after the change, so a client can warn when it reaches zero. Restoring an unhealthy replica returns `routable: false`, honestly. |
| `set_routing_strategy` | `{ strategy }` | The strategy name, from `RoutingConfig`. |
| `set_scoring_weights` | `{ loadWeight, latencyWeight }` | A `notes` entry says when the active strategy does not use weights. |
| `simulate_failure` | `FaultState` (`{ killed, inferFailing }`) | Exactly what the replica reported (P4). `before` omitted. |

**A correction to the task split on weights.** It says only round-robin
ignores the scoring weights. In the code only `latency-weighted` reads them
(`src/routing/strategies/latency-weighted.ts`); `least-loaded` and
`round-robin` both ignore them. Since `least-loaded` is the default,
`set_scoring_weights` under default settings succeeds and changes nothing a
client can see. So the tool adds a `notes` entry whenever the active strategy
is not `latency-weighted`, stating that the weights are stored but not used
until it is.

### Mapping to MCP

Same transport as the reads: one text content block holding the whole
`ActionResult` as JSON. The difference is `isError`, because for an action
"nothing happened" is not a correct answer the way `no_data` is for a read:

| Result | `isError` |
|---|---|
| `ok: true`, any `changed` (`true`, `false`, or `null`) | `false` |
| `unknown_replica` | `true` |
| `invalid_input` | `true` |
| `unsupported` | `true` |
| `internal_error` | `true` |

### Registration

- `ToolDefinition` (in `server.ts`) gains a `kind: "read" | "action"`.
  `defineTool` sets `"read"`, so every M5a tool and test is unchanged.
  `defineActionTool` is the new constructor beside it: it wraps its handler in
  `performAction` and sets `"action"`. `createMcpServer` maps a result to MCP
  by `kind`: reads through `toCallToolResult`, actions through a new
  `toActionCallToolResult` holding the table above.
- `createReadTools` still returns exactly four. A new `createActionTools`
  returns exactly five. Tests pin both sets and the nine-name total, and that
  none of the five action names is ever present on a no-token non-loopback
  bind (P2).

_Sources: `src/mcp/types.ts` (`dispatch`), `src/mcp/server.ts`
(`defineTool`, `toCallToolResult`), `src/routing/config.ts`,
`src/routing/strategies/latency-weighted.ts`, `docs/architecture/m5a.md` §7._

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
  honestly from the admin response. **Resolved in P3:** `before` is
  optional on this one tool, and no `GET /admin/state` is added. Adding a
  replica endpoint would widen the M1 HTTP surface for a field no client
  needs. `changed` is `null` for this tool, not a guess.
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
- **`dispatch`, `defineTool`, and `toCallToolResult`.** Unchanged. The only
  change to `ToolDefinition` is the added `kind` field (P3), which
  `defineTool` sets to `"read"`.
- **No `unauthorized` code in `ActionResult`.** Authentication is rejected at
  the transport (P2).

## Not frozen

- **Wording of the drain explanation** in `explain_routing_decision`. The
  `cites` rule from M5a stays.
- **The default fault mode.** `kill` matches the PRD's wording; changing it is
  additive.

---

## Sign-off checklist

Arundhati's items (Junaid reviewed 2026-10-11):
- [x] P1: `admin` on `ReplicaState`, not a health value; `setAdmin` on
      `RegistryStore` only, `HealthSink` unchanged. Checked against the code:
      `HealthSink` is `Pick<RegistryStore, "updateRuntime" | "setHealth">`
      (`scheduler.ts:26`) and `updateRuntime` takes `Partial<ReplicaRuntime>`,
      so the scheduler cannot write a field on `ReplicaState` at the type
      level. The `setHealth` call she cites is at `scheduler.ts:141`.
- [x] P1: `drained` wins over `unhealthy` in the engine's `excluded` reason.
- [x] P1: draining the last routable replica is allowed and reported.
- [x] P4: three modes on one tool, `revive` clears faults, `restore_replica`
      does not.
- [x] P4: `FaultInjector` off the adapter, `unsupported` when unwired.
      `FaultState` matches the `{ killed, inferFailing }` body the replica's
      admin endpoints return today.
- [x] P4: open question on optional `before`: answered in P3, optional on this
      tool only, no new replica endpoint.

Junaid's items (Arundhati to review):
- [ ] P2: bearer token on the whole endpoint, loopback test, action tools
      unregistered on a non-loopback bind with no token, 401 shape, 16
      character minimum, constant-time compare. The `mcp-remote` header check
      is done and recorded in P2.
- [ ] P3: `ActionResult` and `performAction`, derived `changed` (`null` when
      there is no `before`), `before` required for four tools and optional for
      one, `unauthorized` dropped, `isError` table, `kind` on
      `ToolDefinition`.
- [ ] P3: the weights correction. Only `latency-weighted` reads the scoring
      weights, so `set_scoring_weights` adds a note unless it is active.

