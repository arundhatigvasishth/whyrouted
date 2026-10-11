/**
 * `simulate_failure` (P15, M5b).
 *
 * Injects, or clears, a controlled fault on one simulated replica. Semantics
 * fixed by docs/milestones/m5b/shared-contract.md, P4:
 *
 *   - `kill` (the default): the replica starts failing every request,
 *     /health included, so the health scheduler ejects it after hysteresis.
 *   - `fail_infer`: only /infer fails, /health stays fine, so ejection is
 *     request-driven.
 *   - `revive`: clears either fault. This is the way to undo a simulated
 *     failure (`restore_replica` clears a drain, not a fault).
 *
 * Honest about three things:
 *   - `after` is the fault state the replica itself reported, never assumed
 *     from the mode. There is no way to read a replica's prior state without a
 *     new endpoint, so `before` is omitted and `changed` is `null`.
 *   - The result does not say the replica is now unhealthy. A kill takes about
 *     1.5 seconds to show in the registry, so a note points at
 *     `get_fleet_status` for the health effect.
 *   - With no `FaultInjector` wired (a fleet of real replicas) it returns
 *     `unsupported`, not ok and not a silent no-op.
 */

import { z } from "zod";
import type { RegistryStore } from "../../registry/types.js";
import {
  FAULT_MODES,
  type FaultInjector,
  type FaultMode,
  type FaultState,
} from "../../replica/fault-injector.js";
import { defineActionTool, type ActionToolDefinition } from "../server.js";

export interface SimulateFailureDeps {
  registry: Pick<RegistryStore, "getSnapshot">;
  /** Absent when the fleet is not simulated. The tool then returns `unsupported`. */
  injector?: FaultInjector;
}

const NOTE: Record<FaultMode, string> = {
  kill: "the fault is injected; the replica shows as unhealthy in get_fleet_status only after the health checks notice, about 1.5 seconds at the default settings",
  fail_infer:
    "only inference requests fail; health checks still pass, so the replica is ejected when a live request fails, not by the poll loop",
  revive:
    "the fault is cleared; the replica returns to healthy in get_fleet_status after consecutive successful health checks",
};

export function createSimulateFailureTool(deps: SimulateFailureDeps): ActionToolDefinition {
  return defineActionTool({
    name: "simulate_failure",
    description: `Inject or clear a controlled fault on one simulated replica, for testing and demos. mode is one of ${FAULT_MODES.join(", ")} (default kill): kill fails every request including health checks, fail_infer fails only inference requests, revive clears either fault. Returns the fault state the replica reported. Only available on a simulated fleet.`,
    inputSchema: {
      replica_id: z.string().describe("The replica to inject the fault into, e.g. replica-1"),
      mode: z
        .string()
        .optional()
        .describe(`One of ${FAULT_MODES.join(", ")}. Defaults to kill.`),
    },
    handler: async ({ replica_id, mode }) => {
      const chosen = mode ?? "kill";
      if (!(FAULT_MODES as readonly string[]).includes(chosen)) {
        return {
          kind: "invalid_input" as const,
          reason: `unknown mode ${JSON.stringify(chosen)}, expected one of ${FAULT_MODES.join(", ")}`,
        };
      }
      if (deps.injector === undefined) {
        return {
          kind: "unsupported" as const,
          reason:
            "this fleet does not support fault injection: it is not a simulated fleet, so there is no kill switch to call",
        };
      }
      const known = deps.registry.getSnapshot().replicas.some((r) => r.id === replica_id);
      if (!known) {
        return {
          kind: "unknown_replica" as const,
          reason: `no replica registered with id ${JSON.stringify(replica_id)}`,
        };
      }

      let after: FaultState;
      try {
        after = await deps.injector.inject(replica_id, chosen as FaultMode);
      } catch (err) {
        // Not a state the tool can report: nothing was read back from the replica.
        throw new Error(
          `could not inject ${chosen} into ${replica_id}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      return { kind: "applied" as const, after, notes: [NOTE[chosen as FaultMode]] };
    },
  });
}
