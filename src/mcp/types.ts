/**
 * Tool response envelope and dispatch wrapper (O2 / O6, M5a).
 *
 * Every MCP read tool returns through one shape, so PRD 5.6's grounding rule
 * ("if the data doesn't support an answer, the tool says so explicitly rather
 * than inferring") is enforced here once instead of per tool. A tool handler
 * never builds a `ToolResult`; it returns a `ToolOutput` and `dispatch` turns
 * that into the result a caller sees. Shape fixed by
 * docs/milestones/m5a/shared-contract.md, O2.
 *
 * Imports nothing from the MCP SDK on purpose: mapping a `ToolResult` to an
 * MCP `CallToolResult` is the server scaffold's job at registration, so this
 * file and every tool stay testable without a running server.
 */

export type GroundingSource = "registry" | "failover_log" | "decision_log";

export interface Grounding {
  source: GroundingSource;
  /** ISO 8601. Stamped by `dispatch` when the read ran, never by a tool. */
  queriedAt: string;
  /** Ids of the records the answer was built from: replica ids for the
   *  registry, `FailoverEvent.id`, or `Decision.id`. Never empty on an ok result. */
  recordIds: string[];
}

export type ToolFailureCode = "no_data" | "invalid_input" | "internal_error";

/** What a caller of a tool always gets back. */
export type ToolResult<T> =
  | { ok: true; data: T; groundedIn: Grounding }
  | { ok: false; code: ToolFailureCode; reason: string };

/** What a tool handler returns. It never builds a `ToolResult` itself. */
export type ToolOutput<T> =
  | { kind: "data"; data: T; source: GroundingSource; recordIds: string[] }
  | { kind: "no_data"; reason: string }
  | { kind: "invalid_input"; reason: string };

export type ToolHandler<A, T> = (args: A) => ToolOutput<T> | Promise<ToolOutput<T>>;

export interface DispatchOptions {
  /** Clock for `queriedAt`. Defaults to `() => new Date()`. Tests inject one. */
  now?: () => Date;
}

/**
 * Wrap a handler so every call returns a `ToolResult` and never rejects.
 *
 * - `kind: "data"` with at least one record id becomes `ok: true`, stamped
 *   with `queriedAt`.
 * - `kind: "data"` with no record ids becomes `no_data`: an answer built from
 *   zero records is not an answer (an empty range must not read as a computed
 *   zero).
 * - `no_data` and `invalid_input` pass through with the handler's reason.
 * - A thrown error, sync or async, becomes `internal_error`.
 */
export function dispatch<A, T>(
  handler: ToolHandler<A, T>,
  opts: DispatchOptions = {},
): (args: A) => Promise<ToolResult<T>> {
  const now = opts.now ?? (() => new Date());

  return async (args: A): Promise<ToolResult<T>> => {
    try {
      const out = await handler(args);
      switch (out.kind) {
        case "data":
          if (out.recordIds.length === 0) {
            return { ok: false, code: "no_data", reason: `no records found in ${out.source}` };
          }
          return {
            ok: true,
            data: out.data,
            groundedIn: {
              source: out.source,
              queriedAt: now().toISOString(),
              recordIds: [...out.recordIds],
            },
          };
        case "no_data":
          return { ok: false, code: "no_data", reason: out.reason };
        case "invalid_input":
          return { ok: false, code: "invalid_input", reason: out.reason };
      }
    } catch (err) {
      return {
        ok: false,
        code: "internal_error",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
