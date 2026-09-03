/**
 * HTTP replica adapter.
 *
 * Implements {@link ReplicaAdapter} against the simulated replica servers over
 * real HTTP. Phase 2 replaces this file with an Ollama / vLLM adapter and
 * nothing above the boundary changes.
 *
 * Behaviour is fixed by docs/m1/m1-shared-contract.md:
 *   - checkHealth NEVER rejects; a failed probe resolves
 *     `{ alive: false, latencyMs: <timeout>, inFlight: 0 }`
 *   - sendRequest REJECTS on transport failure, timeout, or non-2xx
 */

import type { Replica } from "../types.js";
import type { HealthResult, ReplicaAdapter, SendResult } from "./types.js";

export interface HttpAdapterOptions {
  /** The fleet. Used to resolve a replica id to its base URL. */
  replicas: Replica[];
  /** Per-probe timeout for `checkHealth`, in ms. */
  healthTimeoutMs: number;
  /** Timeout for `sendRequest`, in ms. Defaults to 10x `healthTimeoutMs`. */
  requestTimeoutMs?: number;
}

export class HttpReplicaAdapter implements ReplicaAdapter {
  private readonly urls: Map<string, string>;
  private readonly healthTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: HttpAdapterOptions) {
    this.urls = new Map(opts.replicas.map((r) => [r.id, r.url]));
    this.healthTimeoutMs = opts.healthTimeoutMs;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? opts.healthTimeoutMs * 10;
  }

  async checkHealth(replicaId: string): Promise<HealthResult> {
    const base = this.resolve(replicaId);
    const failed: HealthResult = {
      alive: false,
      latencyMs: this.healthTimeoutMs,
      inFlight: 0,
    };

    try {
      const startedAt = performance.now();
      const res = await fetchWithTimeout(`${base}/health`, {}, this.healthTimeoutMs);
      const latencyMs = Math.round(performance.now() - startedAt);

      if (!res.ok) return failed;

      const body = (await res.json()) as { inFlight?: unknown };
      const inFlight = typeof body.inFlight === "number" ? body.inFlight : 0;
      return { alive: true, latencyMs, inFlight };
    } catch {
      return failed;
    }
  }

  async sendRequest(replicaId: string, payload: unknown): Promise<SendResult> {
    const base = this.resolve(replicaId);
    const startedAt = performance.now();

    const res = await fetchWithTimeout(
      `${base}/infer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      },
      this.requestTimeoutMs,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!res.ok) {
      throw new Error(`replica "${replicaId}" returned ${res.status} for /infer`);
    }

    return { response: await res.json(), latencyMs };
  }

  private resolve(replicaId: string): string {
    const url = this.urls.get(replicaId);
    if (url === undefined) {
      throw new Error(`unknown replica "${replicaId}"`);
    }
    return url;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
