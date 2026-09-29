# M5a Shared Contract (O1 to O4)

**Status:** O1 drafted by Junaid (2026-09-29), pending Arundhati's review. O2
is drafted next. O3 and O4 (Arundhati's half) are not written yet.
**Covers:** the MCP server's process shape (O1), the tool response envelope
(O2), the `explain_routing_decision` output shape (O3), and the
`query_decisions` natural-language approach (O4).

Landed / to land as:
- O1: `docs/decisions.md` (2026-09-29 entry), `src/main.ts` (wiring, O16)
- O2: `src/mcp/types.ts` (Arundhati, O6)
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

## Sign-off checklist

- [ ] O1 in-process decision and its `docs/decisions.md` entry (Junaid
      drafted 2026-09-29, pending Arundhati).
- [ ] O3 `explain_routing_decision` output shape (Arundhati, not drafted).
- [ ] O4 `query_decisions` approach (Arundhati, not drafted).
- [ ] Whether `get_fleet_status()` returns `RegistrySnapshot` verbatim or a
      reshaped read model, and the `time_range` shape for
      `get_failover_history` (task-split's "also agree" items, not drafted).
