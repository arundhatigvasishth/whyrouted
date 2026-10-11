/**
 * Action result envelope and wrapper (P3 / P12, M5b).
 *
 * Every MCP action tool returns through one shape, beside M5a's `ToolResult`
 * (which does not fit: it turns a result with zero records into `no_data`,
 * right for a read and wrong for an action). A handler never builds an
 * `ActionResult`; it returns an `ActionOutput` and `performAction` turns that
 * into the result a caller sees. Shape fixed by
 * docs/milestones/m5b/shared-contract.md, P3.
 *
 * The rules this enforces once, for every action:
 *   - `changed` is derived from `before` and `after`, never claimed by a
 *     tool, and is `null` when there is no `before` to compare against;
 *   - `appliedAt` is stamped here, after the handler returns;
 *   - a throw, sync or async, becomes `internal_error` and never rejects;
 *   - a failure code is decided by the handler before it writes anything, so a
 *     failed action changed nothing (each tool's tests assert this).
 *
 * Imports nothing from the MCP SDK, like `types.ts`: mapping an
 * `ActionResult` to a protocol result is `server.ts`'s job.
 */

import { isDeepStrictEqual } from "node:util";

export type ActionFailureCode =
  "unknown_replica" | "invalid_input" | "unsupported" | "internal_error";

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

/** What an action handler returns. It never builds an `ActionResult` itself. */
export type ActionOutput<S> =
  | { kind: "applied"; before?: S; after: S; notes?: string[] }
  | { kind: "unknown_replica" | "invalid_input" | "unsupported"; reason: string };

export type ActionHandler<A, S> = (args: A) => ActionOutput<S> | Promise<ActionOutput<S>>;

export interface ActionOptions {
  /** Clock for `appliedAt`. Defaults to `() => new Date()`. Tests inject one. */
  now?: () => Date;
}

/** Wrap a handler so every call returns an `ActionResult` and never rejects. */
export function performAction<A, S>(
  handler: ActionHandler<A, S>,
  opts: ActionOptions = {},
): (args: A) => Promise<ActionResult<S>> {
  const now = opts.now ?? (() => new Date());

  return async (args: A): Promise<ActionResult<S>> => {
    try {
      const out = await handler(args);
      if (out.kind !== "applied") {
        return { ok: false, code: out.kind, reason: out.reason };
      }
      const hasBefore = out.before !== undefined;
      return {
        ok: true,
        changed: hasBefore ? !isDeepStrictEqual(out.before, out.after) : null,
        ...(hasBefore && { before: out.before }),
        after: out.after,
        appliedAt: now().toISOString(),
        ...(out.notes !== undefined && out.notes.length > 0 && { notes: [...out.notes] }),
      };
    } catch (err) {
      return {
        ok: false,
        code: "internal_error",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
