/**
 * Health scheduler.
 *
 * Polls every replica through the adapter on a fixed interval and drives a
 * per-replica hysteresis state machine:
 *   - `unknown` → `healthy`   after M consecutive successful probes
 *   - not `unhealthy` → `unhealthy` after N consecutive failed probes
 *   - `unhealthy` → `healthy`  after M consecutive successes (recovery)
 * Hysteresis (N != 1, M != 1) is what stops a single blip from flapping a
 * replica in and out of rotation.
 *
 * Self-contained on purpose: it depends on the `ReplicaAdapter` interface and a
 * two-method `HealthSink`, not on the concrete registry or HTTP client, so it
 * can be lifted into its own service later (final architecture, PRD §6) without
 * a rewrite.
 *
 * The `HealthResult` → runtime mapping is fixed by docs/milestones/m1/shared-contract.md:
 * a failed probe writes `latencyMs: null` and `inFlight: 0`.
 */

import type { ReplicaHealth } from "../types.js";
import type { ReplicaAdapter } from "../adapter/types.js";
import type { RegistryStore } from "../registry/types.js";

/** Where the scheduler writes results — the registry satisfies this. */
export type HealthSink = Pick<RegistryStore, "updateRuntime" | "setHealth">;

export interface HealthTransition {
  replicaId: string;
  from: ReplicaHealth;
  to: ReplicaHealth;
  /** ISO 8601 timestamp of the poll that caused the transition. */
  at: string;
}

export interface SchedulerOptions {
  adapter: ReplicaAdapter;
  sink: HealthSink;
  /** Replica ids to poll. Must already be registered in the sink. */
  replicaIds: string[];
  /** Poll interval in ms. */
  intervalMs: number;
  /** N — consecutive failures before a replica is marked `unhealthy`. */
  unhealthyThreshold: number;
  /** M — consecutive successes before a replica becomes / recovers to `healthy`. */
  healthyThreshold: number;
  /** Called on every health-state change. */
  onTransition?: (transition: HealthTransition) => void;
  /** Clock, injectable for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface ReplicaHysteresis {
  health: ReplicaHealth;
  consecFailures: number;
  consecSuccesses: number;
}

export class HealthScheduler {
  private readonly opts: SchedulerOptions;
  private readonly now: () => Date;
  private readonly hysteresis = new Map<string, ReplicaHysteresis>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    for (const id of opts.replicaIds) {
      this.hysteresis.set(id, { health: "unknown", consecFailures: 0, consecSuccesses: 0 });
    }
  }

  /** Begin polling: one immediate sweep, then every `intervalMs`. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.opts.intervalMs);
    // the scheduler alone should not hold the process open — main's server does
    this.timer.unref();
  }

  /** Stop polling. Idempotent. In-flight probes are allowed to finish. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Take a replica out of rotation immediately, driven by a live request
   * failure rather than the poll loop (L2, M3). Marks it `unhealthy` right
   * now instead of waiting for `unhealthyThreshold` failed probes — the
   * whole point of request-driven ejection (see docs/milestones/m3/task-split.md
   * §1). Recovery is untouched: it still needs `healthyThreshold` consecutive
   * clean probes, same as a health-check-driven `unhealthy`, so an ejected
   * replica cannot rejoin on one lucky probe.
   *
   * `reason` is for logs/observability only. Recording a queryable
   * `FailoverEvent` for this ejection is the caller's job (M3's retry loop,
   * L11 + L12) — this method only drives the hysteresis state machine and
   * `onTransition`, same as a poll-driven transition would.
   *
   * No-ops (still calls `sink.setHealth` idempotently) if the replica is
   * already `unhealthy`. Throws on an unregistered replica id.
   */
  eject(replicaId: string, reason: string): void {
    const state = this.hysteresis.get(replicaId);
    if (state === undefined) {
      throw new Error(`cannot eject unknown replica "${replicaId}"`);
    }
    const at = this.now().toISOString();
    const from = state.health;

    state.consecSuccesses = 0;
    state.consecFailures = this.opts.unhealthyThreshold;
    state.health = "unhealthy";
    this.opts.sink.setHealth(replicaId, "unhealthy");

    console.log(`${replicaId}: ejected (${reason})`);
    if (from !== "unhealthy") {
      this.opts.onTransition?.({ replicaId, from, to: "unhealthy", at });
    }
  }

  /**
   * Probe every replica once. Overlapping sweeps are skipped — if a sweep is
   * still running when the interval fires, that tick is dropped rather than
   * stacking probes on a struggling fleet.
   */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(this.opts.replicaIds.map((id) => this.pollOne(id)));
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(id: string): Promise<void> {
    const result = await this.opts.adapter.checkHealth(id);
    const state = this.hysteresis.get(id);
    if (state === undefined) return;
    const at = this.now().toISOString();

    if (result.alive) {
      state.consecSuccesses += 1;
      state.consecFailures = 0;
      this.opts.sink.updateRuntime(id, {
        inFlight: result.inFlight,
        latencyMs: result.latencyMs,
        consecFailures: 0,
        consecSuccesses: state.consecSuccesses,
        lastCheckedAt: at,
      });
      if (state.health !== "healthy" && state.consecSuccesses >= this.opts.healthyThreshold) {
        this.transition(id, state, "healthy", at);
      }
    } else {
      state.consecFailures += 1;
      state.consecSuccesses = 0;
      this.opts.sink.updateRuntime(id, {
        inFlight: 0,
        latencyMs: null,
        consecFailures: state.consecFailures,
        consecSuccesses: 0,
        lastCheckedAt: at,
      });
      if (state.health !== "unhealthy" && state.consecFailures >= this.opts.unhealthyThreshold) {
        this.transition(id, state, "unhealthy", at);
      }
    }
  }

  private transition(id: string, state: ReplicaHysteresis, to: ReplicaHealth, at: string): void {
    const from = state.health;
    state.health = to;
    this.opts.sink.setHealth(id, to);
    this.opts.onTransition?.({ replicaId: id, from, to, at });
  }
}
