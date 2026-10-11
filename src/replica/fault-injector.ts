/**
 * Fault injection for the simulated fleet (P4 / P15, M5b).
 *
 * Deliberately NOT part of `ReplicaAdapter`. The adapter is exactly two
 * functions (docs/decisions.md, 2026-09-01) because Phase 2 swaps the
 * simulated replicas for real Ollama or vLLM servers by implementing those
 * two. A kill switch exists only on simulated replicas, so it lives in this
 * separate interface, implemented only here. A fleet without one simply has no
 * `FaultInjector`, and the MCP tool says `unsupported` instead of doing
 * nothing. Shape fixed by docs/milestones/m5b/shared-contract.md, P4.
 *
 * This wraps the replica admin endpoints that already exist (`/admin/kill`,
 * `/admin/fail-infer`, `/admin/revive`) and adds none. `FaultState` is exactly
 * the body those endpoints return, forwarded and checked, never invented.
 */

import type { Replica } from "../types.js";

export type FaultMode = "kill" | "fail_infer" | "revive";

export const FAULT_MODES: readonly FaultMode[] = ["kill", "fail_infer", "revive"];

export interface FaultState {
  killed: boolean;
  inferFailing: boolean;
}

export interface FaultInjector {
  /** Applies the mode and returns the replica's own report of its fault state. */
  inject(replicaId: string, mode: FaultMode): Promise<FaultState>;
}

const ADMIN_PATH: Record<FaultMode, string> = {
  kill: "/admin/kill",
  fail_infer: "/admin/fail-infer",
  revive: "/admin/revive",
};

export interface HttpFaultInjectorOptions {
  replicas: readonly Replica[];
  /** Per-call timeout in ms. Defaults to 2000. */
  timeoutMs?: number;
  /** `fetch`, injectable for tests. */
  fetchImpl?: typeof fetch;
}

function isFaultState(body: unknown): body is FaultState {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as FaultState).killed === "boolean" &&
    typeof (body as FaultState).inferFailing === "boolean"
  );
}

/**
 * An injector that calls each simulated replica's admin endpoint over HTTP.
 * Throws if the replica is unknown, unreachable, answers non-2xx, or answers
 * with a body that is not a `FaultState`: a result is only ever what the
 * replica reported.
 */
export function createHttpFaultInjector(opts: HttpFaultInjectorOptions): FaultInjector {
  const urls = new Map(opts.replicas.map((r) => [r.id, r.url]));
  const timeoutMs = opts.timeoutMs ?? 2000;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async inject(replicaId, mode) {
      const base = urls.get(replicaId);
      if (base === undefined) throw new Error(`no admin endpoint known for replica "${replicaId}"`);

      const res = await doFetch(`${base}${ADMIN_PATH[mode]}`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`replica "${replicaId}" answered ${res.status} to ${ADMIN_PATH[mode]}`);
      }
      const body: unknown = await res.json();
      if (!isFaultState(body)) {
        throw new Error(
          `replica "${replicaId}" returned an unexpected body from ${ADMIN_PATH[mode]}`,
        );
      }
      return { killed: body.killed, inferFailing: body.inferFailing };
    },
  };
}
