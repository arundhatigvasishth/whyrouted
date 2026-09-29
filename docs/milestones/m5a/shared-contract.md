# M5a Shared Contract (O1 to O4)

**Status:** O1 and O2 drafted by Junaid (2026-09-29), pending Arundhati's
review. O3 and O4 (Arundhati's half) are not written yet. O5 through O14 do
not start against O2 until it is signed off here.
**Covers:** the MCP server's process shape (O1), the tool response envelope
(O2), the `explain_routing_decision` output shape (O3), and the
`query_decisions` natural-language approach (O4).

Landed / to land as:
- O1: `docs/decisions.md` (2026-09-29 entry), `src/main.ts` (wiring, O16)
- O2: `src/mcp/types.ts` (Arundhati, O6, built from the shape below)
- O3: `src/mcp/tools/explain-routing-decision.ts` (signature only)
- O4: `src/mcp/tools/query-decisions.ts` (signature only)

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
- **`dispatch` is async and awaits the handler**, and `ToolHandler` may
  return a plain value or a Promise. Every store call is synchronous today, so
  handlers can be too. When M8 splits the deployment and the stores widen to
  Promises, a handler becomes async with no change to its signature or to
  anything that registers it.

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

## Sign-off checklist

- [ ] O1 in-process decision and its `docs/decisions.md` entry (Junaid
      drafted 2026-09-29, pending Arundhati).
- [ ] O2 envelope: `ToolResult` / `ToolOutput` shapes, the `dispatch`
      signature, and the zero-records-means-no-data rule (Junaid drafted
      2026-09-29, pending Arundhati).
- [ ] O3 `explain_routing_decision` output shape (Arundhati, not drafted).
- [ ] O4 `query_decisions` approach (Arundhati, not drafted).
- [ ] Whether `get_fleet_status()` returns `RegistrySnapshot` verbatim or a
      reshaped read model, and the `time_range` shape for
      `get_failover_history` (task-split's "also agree" items, not drafted).
